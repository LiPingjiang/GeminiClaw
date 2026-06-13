/**
 * GeminiClaw Sandbox Task Queue Server
 *
 * A standalone Fastify server acting as a message broker between
 * GeminiClaw (task submitter) and a local sandbox-proxy worker (task executor).
 *
 * Run: tsx src/sandbox/queue-server.ts
 * Port: 3200
 */

import Fastify, { type FastifyRequest, type FastifyReply } from 'fastify'

// ─── Types ───────────────────────────────────────────────────────────────────

interface TaskInput {
  code: string
  language?: 'python' | 'bash'
  timeout?: number
  key_preference?: 'key1' | 'key2' | 'key3' | 'any'
}

interface TaskResult {
  stdout: string
  stderr: string
  exitCode: number
}

interface Task {
  taskId: string
  status: 'pending' | 'running' | 'completed' | 'failed'
  code: string
  language: 'python' | 'bash'
  timeout: number
  key_preference: 'key1' | 'key2' | 'key3' | 'any'
  result?: TaskResult
  error?: string
  createdAt: string
  startedAt?: string
  completedAt?: string
}

// ─── State ───────────────────────────────────────────────────────────────────

const AUTH_TOKEN = 'gc-sandbox-2026'
const PORT = 3200
const TASK_EXPIRY_MS = 10 * 60 * 1000 // 10 minutes
const MAX_COMPLETED = 100

const tasks = new Map<string, Task>()
const pendingQueue: string[] = [] // taskIds in FIFO order

// Waiters for long-poll
let pendingWaiters: Array<{
  resolve: (task: Task | null) => void
  timer: ReturnType<typeof setTimeout>
}> = []

// ─── Helpers ─────────────────────────────────────────────────────────────────

function generateId(): string {
  return `task_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`
}

function log(action: string, detail?: string): void {
  const ts = new Date().toISOString()
  console.log(`[${ts}] ${action}${detail ? ' — ' + detail : ''}`)
}

function getCountsByStatus() {
  let pending = 0
  let running = 0
  let completed = 0
  let failed = 0
  for (const t of tasks.values()) {
    if (t.status === 'pending') pending++
    else if (t.status === 'running') running++
    else if (t.status === 'completed') completed++
    else if (t.status === 'failed') failed++
  }
  return { pending, running, completed, failed }
}

// ─── Expiry & Cleanup ────────────────────────────────────────────────────────

function expireOldTasks(): void {
  const now = Date.now()
  for (const [id, task] of tasks) {
    if (task.status === 'pending' || task.status === 'running') {
      const created = new Date(task.createdAt).getTime()
      if (now - created > TASK_EXPIRY_MS) {
        task.status = 'failed'
        task.error = 'Task expired (10 minute timeout)'
        task.completedAt = new Date().toISOString()
        log('EXPIRED', id)
      }
    }
  }
  // Trim completed/failed tasks to last MAX_COMPLETED
  const doneTasks = [...tasks.entries()]
    .filter(([, t]) => t.status === 'completed' || t.status === 'failed')
    .sort((a, b) => {
      const aTime = a[1].completedAt ? new Date(a[1].completedAt).getTime() : 0
      const bTime = b[1].completedAt ? new Date(b[1].completedAt).getTime() : 0
      return aTime - bTime
    })
  while (doneTasks.length > MAX_COMPLETED) {
    const [id] = doneTasks.shift()!
    tasks.delete(id)
  }
}

// Run expiry check every 30 seconds
setInterval(expireOldTasks, 30_000)

// ─── Server Setup ────────────────────────────────────────────────────────────

const app = Fastify({ logger: false })

// Auth preHandler for all routes except /health
app.addHook('preHandler', async (request: FastifyRequest, reply: FastifyReply) => {
  if (request.url === '/health') return
  const auth = request.headers.authorization
  if (!auth || auth !== `Bearer ${AUTH_TOKEN}`) {
    reply.status(401).send({ error: 'Unauthorized' })
  }
})

// ─── Routes ──────────────────────────────────────────────────────────────────

// POST /tasks — Submit a new task
app.post('/tasks', async (request: FastifyRequest, reply: FastifyReply) => {
  const body = request.body as TaskInput | undefined

  if (!body || typeof body.code !== 'string' || body.code.trim() === '') {
    return reply.status(400).send({ error: 'Missing required field: code' })
  }

  const task: Task = {
    taskId: generateId(),
    status: 'pending',
    code: body.code,
    language: body.language || 'python',
    timeout: body.timeout || 60,
    key_preference: body.key_preference || 'any',
    createdAt: new Date().toISOString(),
  }

  tasks.set(task.taskId, task)
  pendingQueue.push(task.taskId)
  log('SUBMIT', `${task.taskId} [${task.language}] ${task.code.slice(0, 60)}...`)

  // Notify any long-poll waiters
  if (pendingWaiters.length > 0) {
    const waiter = pendingWaiters.shift()!
    clearTimeout(waiter.timer)
    // Mark as running
    task.status = 'running'
    task.startedAt = new Date().toISOString()
    // Remove from pending queue
    const idx = pendingQueue.indexOf(task.taskId)
    if (idx !== -1) pendingQueue.splice(idx, 1)
    log('DISPATCH', `${task.taskId} (long-poll)`)
    waiter.resolve(task)
  }

  return reply.status(201).send({ taskId: task.taskId, status: task.status })
})

// GET /tasks/pending — Worker polls for next task
app.get('/tasks/pending', async (request: FastifyRequest, reply: FastifyReply) => {
  const query = request.query as { wait?: string }
  const waitSeconds = query.wait ? Math.min(parseInt(query.wait, 10) || 0, 60) : 0

  // Try to find a pending task immediately
  while (pendingQueue.length > 0) {
    const taskId = pendingQueue.shift()!
    const task = tasks.get(taskId)
    if (task && task.status === 'pending') {
      task.status = 'running'
      task.startedAt = new Date().toISOString()
      log('DISPATCH', taskId)
      return reply.send(task)
    }
  }

  // No pending task available
  if (waitSeconds <= 0) {
    return reply.status(204).send()
  }

  // Long-poll: wait for a task
  return new Promise<void>((resolve) => {
    const timer = setTimeout(() => {
      // Remove this waiter
      pendingWaiters = pendingWaiters.filter((w) => w.timer !== timer)
      reply.status(204).send()
      resolve()
    }, waitSeconds * 1000)

    pendingWaiters.push({
      resolve: (task) => {
        if (task) {
          reply.send(task)
        } else {
          reply.status(204).send()
        }
        resolve()
      },
      timer,
    })
  })
})

// GET /tasks/:id — Get task status/result
app.get('/tasks/:id', async (request: FastifyRequest, reply: FastifyReply) => {
  const { id } = request.params as { id: string }
  const task = tasks.get(id)

  if (!task) {
    return reply.status(404).send({ error: 'Task not found' })
  }

  const response: Record<string, unknown> = {
    taskId: task.taskId,
    status: task.status,
    createdAt: task.createdAt,
  }
  if (task.startedAt) response.startedAt = task.startedAt
  if (task.completedAt) response.completedAt = task.completedAt
  if (task.result) response.result = task.result
  if (task.error) response.error = task.error

  return reply.send(response)
})

// PUT /tasks/:id/result — Worker submits result
app.put('/tasks/:id/result', async (request: FastifyRequest, reply: FastifyReply) => {
  const { id } = request.params as { id: string }
  const task = tasks.get(id)

  if (!task) {
    return reply.status(404).send({ error: 'Task not found' })
  }

  if (task.status !== 'running') {
    return reply.status(409).send({
      error: `Task is not running (current status: ${task.status})`,
    })
  }

  const body = request.body as
    | { stdout?: string; stderr?: string; exitCode?: number; error?: string }
    | undefined

  if (!body) {
    return reply.status(400).send({ error: 'Missing request body' })
  }

  task.completedAt = new Date().toISOString()

  if (body.error) {
    task.status = 'failed'
    task.error = body.error
    log('FAILED', `${id} — ${body.error}`)
  } else {
    task.status = 'completed'
    task.result = {
      stdout: body.stdout || '',
      stderr: body.stderr || '',
      exitCode: body.exitCode ?? 0,
    }
    log('COMPLETED', `${id} — exit ${task.result.exitCode}`)
  }

  return reply.send({ taskId: task.taskId, status: task.status })
})

// GET /health — Health check (no auth required)
app.get('/health', async (_request: FastifyRequest, reply: FastifyReply) => {
  const counts = getCountsByStatus()
  return reply.send({
    status: 'ok',
    pendingCount: counts.pending,
    runningCount: counts.running,
    completedCount: counts.completed + counts.failed,
  })
})

// ─── Start ───────────────────────────────────────────────────────────────────

async function start() {
  try {
    await app.listen({ port: PORT, host: '0.0.0.0' })
    log('SERVER', `Task Queue Server running on http://0.0.0.0:${PORT}`)
    log('SERVER', `Auth token: Bearer ${AUTH_TOKEN}`)
    log('SERVER', `Task expiry: ${TASK_EXPIRY_MS / 1000}s | Max completed: ${MAX_COMPLETED}`)
  } catch (err) {
    console.error('Failed to start server:', err)
    process.exit(1)
  }
}

start()
