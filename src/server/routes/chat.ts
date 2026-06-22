// src/server/routes/chat.ts
import type { FastifyInstance } from "fastify"
import type { ProviderRouter } from "../../providers/router.js"
import type { MemoryStrategy } from "../../memory/strategy.js"
import type { TwinSystemInstance } from "../../twin-system/factory.js"
import type { AgentLoop } from "../../agent/index.js"
import { existsSync } from "fs"
import { MemoryPaths } from "../../memory/paths.js"
import type { Db } from "../../db/client.js"


interface ChatBody {
  message: string
  sessionId?: string
  agentId?: string
  model?: string
  stream?: boolean
}

interface ReplayBody {
  /** The session to replay from */
  sourceSessionId: string
  /** User message to inject (same as original or modified) */
  message: string
  /** Load history before this ISO timestamp (e.g. "2026-06-22T15:42:00Z") */
  beforeTime?: string
  /** Load history before this DB row id */
  beforeId?: number
  /** Agent ID for identity injection */
  agentId?: string
  /** Override model */
  model?: string
  /** If true, don't persist replay results (default: true) */
  dryRun?: boolean
}

interface ChatRouteOpts {
  router: ProviderRouter
  strategy: MemoryStrategy
  authToken?: string
  agentLoop?: AgentLoop
  twinSystem?: TwinSystemInstance
  db?: Db
}

export async function chatRoute(
  fastify: FastifyInstance,
  opts: ChatRouteOpts,
): Promise<void> {
  fastify.post<{ Body: ChatBody }>("/v1/agent/chat", async (request, reply) => {
    if (opts.authToken) {
      const auth = request.headers["authorization"]
      if (!auth || auth !== `Bearer ${opts.authToken}`) {
        return reply.status(401).send({ error: "Unauthorized" })
      }
    }

    const { message, sessionId, agentId, model, stream: wantStream } = request.body

    // 输入校验
    if (!message || typeof message !== "string" || message.trim() === "") {
      return reply.status(400).send({ error: "message is required and must be a non-empty string" })
    }

    const sid = sessionId ?? crypto.randomUUID()

    await opts.strategy.ensureSession(sid)

    // 0. 斜杠命令拦截 —— /进化、/状态、/技能 等命令直接走工具，不经过 LLM
    const { CommandParser } = await import("../../agent/command-parser.js")
    if (CommandParser.isCommand(message)) {
      const commandArgs = CommandParser.toToolCallArgs(message)
      if (commandArgs) {
        const { registry } = await import("../../tools/registry.js")
        // 确保 evolution_command 工具已注册（side-effect import）
        await import("../../tools/evolution_command.js")
        const toolEntry = registry.get("evolution_command")
        if (toolEntry) {
          const result = (await toolEntry.handler(commandArgs, {
            sessionId: sid,
            workdir: process.cwd(),
            logger: { info: () => undefined, warn: () => undefined, error: () => undefined },
          })) as { type: string; text?: string; error?: string }
          const resultText =
            result.type === "text"
              ? result.text ?? "命令执行失败"
              : result.type === "error"
                ? `❌ ${result.error}`
                : "命令执行失败"

          opts.twinSystem?.activityTracker.recordActivity()

          if (wantStream) {
            reply.hijack()
            const raw = reply.raw
            raw.writeHead(200, {
              "Content-Type": "text/event-stream",
              "Cache-Control": "no-cache",
              "Connection": "keep-alive",
            })
            const data = JSON.stringify({ choices: [{ delta: { content: resultText } }] })
            raw.write(`data: ${data}\n\n`)
            raw.write(`data: ${JSON.stringify({ type: "done" })}\n\n`)
            raw.write("data: [DONE]\n\n")
            raw.end()
            return
          }

          return reply.send({ response: resultText, sessionId: sid, model: "command" })
        }
      }
    }

    // 1. 获取 context（含 system + 事项索引 + 历史）
    const { messages: contextMessages } = await opts.strategy.getContext(sid, message, agentId ?? undefined)

    // 2. Inject agent identity system message (same logic as QQBot channel)
    let agentIdentityMsg: { role: "system"; content: string } | null = null
    if (agentId && opts.db) {
      const agentRow = opts.db
        .prepare("SELECT agent_name, description FROM agents WHERE id = ?")
        .get(agentId) as { agent_name: string; description: string | null } | undefined
      if (agentRow) {
        const hasFixedOnDisk = existsSync(new MemoryPaths().agentAgentMd(agentId))
        if (!hasFixedOnDisk) {
          agentIdentityMsg = {
            role: "system" as const,
            content: `## 当前助手身份\n你现在以【${agentRow.agent_name}】身份工作。${agentRow.description ? "\n职责：" + agentRow.description : ""}`,
          }
        }
      }
    }

    // 3. 追加当前用户消息
    const allMessages = [
      ...contextMessages,
      ...(agentIdentityMsg ? [agentIdentityMsg] : []),
      { role: "user" as const, content: message },
    ]

    // ─── 使用 AgentLoop 执行（带工具调用能力） ───
    if (opts.agentLoop) {
      if (wantStream) {
        // SSE 流式 + AgentLoop
        reply.hijack()
        const raw = reply.raw
        raw.writeHead(200, {
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-cache",
          "Connection": "keep-alive",
        })

        let fullContent = ""

        try {
          const eventStream = opts.agentLoop.run({
            messages: allMessages as any,
            sessionId: sid,
            model,
          })

          for await (const event of eventStream) {
            if (event.type === "message_delta") {
              fullContent += event.delta
              const data = JSON.stringify({ choices: [{ delta: { content: event.delta } }] })
              raw.write(`data: ${data}\n\n`)
            } else if (event.type === "context_warning") {
              const notice = `\n\n⚠️ *上下文已用 ${event.usedPercent}%（约 ${Math.round(event.inputTokens / 1000)}k tokens），对话历史较长，建议在本轮完成后开始新会话。*`
              const data = JSON.stringify({ choices: [{ delta: { content: notice } }] })
              raw.write(`data: ${data}\n\n`)
            } else if (event.type === "compacted") {
              const notice = `\n\n🗜️ *上下文已自动压缩（节省 ${event.savedMessages} 条旧消息），继续工作中…*\n\n`
              const data = JSON.stringify({ choices: [{ delta: { content: notice } }] })
              raw.write(`data: ${data}\n\n`)
            }
          }

          // 2026-06-17: P6 防护 — 如果 AgentLoop 完成但没有产生任何文本内容，发送提示
          if (!fullContent) {
            const fallbackMsg = "⚠️ 处理完成但未生成文本回复。可能是工具调用超时或内部错误，请简化问题重试。"
            const data = JSON.stringify({ choices: [{ delta: { content: fallbackMsg } }] })
            raw.write(`data: ${data}\n\n`)
            fullContent = fallbackMsg
          }

          raw.write(`data: ${JSON.stringify({ type: "done" })}\n\n`)
          raw.write("data: [DONE]\n\n")

          if (fullContent) {
            await opts.strategy.appendTurn(
              sid,
              { role: "user", content: message },
              { role: "assistant", content: fullContent },
            )
            opts.twinSystem?.activityTracker.recordActivity()
          }
        } catch (err) {
          raw.write(`data: ${JSON.stringify({ error: String(err) })}\n\n`)
        } finally {
          raw.end()
        }
        return
      }

      // 非流式 + AgentLoop：收集所有 message_delta 事件
      // ⚠️ 2026-06-17: 添加请求级超时保护，防止 AgentLoop 工具调用卡死导致 session 永久挂起
      // 回滚方案：移除 Promise.race 包装，恢复原始 for-await 循环
      const REQUEST_TIMEOUT_MS = 600_000 // 10 分钟超时
      let fullContent = ""
      const eventStream = opts.agentLoop.run({
        messages: allMessages as any,
        sessionId: sid,
        model,
      })

      const collectEvents = async () => {
        for await (const event of eventStream) {
          if (event.type === "context_warning") {
            fullContent += `\n\n⚠️ *上下文已用 ${event.usedPercent}%，建议在本轮完成后开始新会话。*`
          } else if (event.type === "compacted") {
            fullContent += `\n\n🗜️ *上下文已自动压缩（节省 ${event.savedMessages} 条旧消息）。*\n\n`
          } else if (event.type === "message_delta") {
            fullContent += event.delta
          }
        }
      }

      const timeoutPromise = new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error(`Request timeout after ${REQUEST_TIMEOUT_MS / 1000}s`)), REQUEST_TIMEOUT_MS),
      )

      try {
        await Promise.race([collectEvents(), timeoutPromise])
      } catch (err) {
        // 超时或其他错误：返回已收集的部分内容 + 错误提示
        const timeoutMsg = fullContent
          ? `\n\n⚠️ 响应超时（${REQUEST_TIMEOUT_MS / 1000}秒），以上为已生成的部分内容。`
          : `⚠️ 响应超时（${REQUEST_TIMEOUT_MS / 1000}秒），请简化问题或使用流式模式（stream: true）。`
        fullContent += timeoutMsg
      }

      if (fullContent) {
        await opts.strategy.appendTurn(
          sid,
          { role: "user", content: message },
          { role: "assistant", content: fullContent },
        )
        opts.twinSystem?.activityTracker.recordActivity()
      }

      return reply.send({
        response: fullContent,
        sessionId: sid,
        model: model ?? "unknown",
      })
    }

    // ─── Fallback：无 AgentLoop 时直接调用 router（无工具能力） ───
    if (wantStream) {
      reply.hijack()
      const raw = reply.raw
      raw.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        "Connection": "keep-alive",
      })

      let fullContent = ""

      try {
        for await (const chunk of opts.router.stream(allMessages, model ? { model } : undefined)) {
          if (chunk.delta) {
            fullContent += chunk.delta
            const data = JSON.stringify({ choices: [{ delta: { content: chunk.delta } }] })
            raw.write(`data: ${data}\n\n`)
          }
          if (chunk.done) {
            raw.write(`data: ${JSON.stringify({ type: "done" })}\n\n`)
            raw.write("data: [DONE]\n\n")
          }
        }
      } catch (err) {
        raw.write(`data: ${JSON.stringify({ error: String(err) })}\n\n`)
      } finally {
        raw.end()
      }

      if (fullContent) {
        await opts.strategy.appendTurn(
          sid,
          { role: "user", content: message },
          { role: "assistant", content: fullContent },
        )
        opts.twinSystem?.activityTracker.recordActivity()
      }

      return
    }

    // 非流式 fallback
    const chatResponse = await opts.router.chat(allMessages, model ? { model } : undefined)

    await opts.strategy.appendTurn(
      sid,
      { role: "user", content: message },
      { role: "assistant", content: chatResponse.content },
    )

    opts.twinSystem?.activityTracker.recordActivity()

    return reply.send({
      response: chatResponse.content,
      sessionId: sid,
      model: chatResponse.model,
    })
  })

  // ==========================================================================
  // /v1/agent/replay - Replay a past session's context through full agentLoop
  // ==========================================================================
  fastify.post<{ Body: ReplayBody }>("/v1/agent/replay", async (request, reply) => {
    if (opts.authToken) {
      const auth = request.headers["authorization"]
      if (!auth || auth !== `Bearer ${opts.authToken}`) {
        return reply.status(401).send({ error: "Unauthorized" })
      }
    }

    const { sourceSessionId, message, beforeTime, beforeId, agentId, model, dryRun } = request.body
    if (!sourceSessionId || !message) {
      return reply.status(400).send({ error: "sourceSessionId and message are required" })
    }

    const isDryRun = dryRun !== false // default true

    // 1. Load history from source session with time/id filter
    let whereClause = "WHERE session_id = ?"
    const params: unknown[] = [sourceSessionId]

    if (beforeTime) {
      whereClause += " AND created_at < ?"
      params.push(beforeTime)
    } else if (beforeId) {
      whereClause += " AND id < ?"
      params.push(beforeId)
    }

    const rows = opts.db!.prepare(`
      SELECT role, content, tool_calls, tool_call_id, created_at
      FROM chat_messages
      ${whereClause}
      ORDER BY id ASC
      LIMIT 600
    `).all(...params) as Array<{
      role: string; content: string; tool_calls: string | null;
      tool_call_id: string | null; created_at: string
    }>

    if (rows.length === 0) {
      return reply.status(404).send({
        error: `No messages found in session ${sourceSessionId}` +
          (beforeTime ? ` before ${beforeTime}` : beforeId ? ` before id ${beforeId}` : "")
      })
    }

    // 2. Build messages array from DB rows
    const historyMessages = rows.map(row => {
      const msg: Record<string, unknown> = { role: row.role, content: row.content }
      if (row.tool_calls) {
        try { msg.tool_calls = JSON.parse(row.tool_calls) } catch {}
      }
      if (row.tool_call_id) msg.tool_call_id = row.tool_call_id
      return msg
    })

    // 3. Inject agent identity (same as chat route)
    let agentIdentityMsg: { role: "system"; content: string } | null = null
    if (agentId && opts.db) {
      const agentRow = opts.db
        .prepare("SELECT agent_name, description FROM agents WHERE id = ?")
        .get(agentId) as { agent_name: string; description: string | null } | undefined
      if (agentRow) {
        agentIdentityMsg = {
          role: "system" as const,
          content: `## \u5f53\u524d\u52a9\u624b\u8eab\u4efd\n\u4f60\u73b0\u5728\u4ee5\u3010${agentRow.agent_name}\u3011\u8eab\u4efd\u5de5\u4f5c\u3002${agentRow.description ? "\n\u804c\u8d23\uff1a" + agentRow.description : ""}`,
        }
      }
    }

    // 4. Assemble full message array (history + identity + new user message)
    const allMessages = [
      ...historyMessages,
      ...(agentIdentityMsg ? [agentIdentityMsg] : []),
      { role: "user" as const, content: message },
    ]

    // 5. Create a replay session ID (won't pollute original)
    const replaySessionId = `replay-${sourceSessionId.slice(0, 8)}-${Date.now()}`

    console.log(
      `[Replay] source=${sourceSessionId} msgs=${historyMessages.length} ` +
      `beforeTime=${beforeTime ?? "none"} beforeId=${beforeId ?? "none"} ` +
      `replaySession=${replaySessionId} dryRun=${isDryRun}`
    )

    // 6. Run through agentLoop (full tool execution + guardrails)
    if (!opts.agentLoop) {
      return reply.status(500).send({ error: "AgentLoop not available" })
    }

    let fullContent = ""
    const events: Array<{ type: string; [k: string]: unknown }> = []

    try {
      const eventStream = opts.agentLoop.run({
        messages: allMessages as any,
        sessionId: replaySessionId,
        model,
      })

      for await (const event of eventStream) {
        if (event.type === "message_delta") {
          fullContent += event.delta
        }
        // Collect key events for diagnostics
        if (event.type === "turn_start" || event.type === "tool_start" ||
            event.type === "tool_end" || event.type === "agent_end" ||
            event.type === "guardrail_warn" || event.type === "guardrail_halt") {
          events.push(event as any)
        }
      }
    } catch (err) {
      return reply.status(500).send({
        error: `Replay failed: ${String(err)}`,
        partialResponse: fullContent || undefined,
        events,
      })
    }

    // 7. Optionally persist (default: don't)
    if (!isDryRun && fullContent) {
      await opts.strategy.ensureSession(replaySessionId)
      await opts.strategy.appendTurn(
        replaySessionId,
        { role: "user", content: message },
        { role: "assistant", content: fullContent },
      )
    }

    return reply.send({
      response: fullContent,
      replaySessionId,
      sourceSessionId,
      historyMessageCount: historyMessages.length,
      totalTurns: events.filter(e => e.type === "turn_start").length,
      toolCalls: events.filter(e => e.type === "tool_start").map(e => (e as any).toolName),
      events: events.slice(0, 50), // cap at 50 for response size
      dryRun: isDryRun,
    })
  })
}
