# GeminiClaw Agent Mesh 设计文档

> 状态：设计完成，待实现  
> 作者：观澜  
> 日期：2026-05-24  
> 定位：替换单 AgentLoop 串行模型，引入并发 Actor Mesh 架构

---

## 一、问题背景

当前 GeminiClaw 是单 AgentLoop 串行处理：消息进来 → 放队列 → 一条处理完再处理下一条。并发吞吐极差，用户连发多条消息或多个任务并行时体验崩溃。

目标：引入 **Dispatcher-Worker Actor Mesh**，显著提升吞吐，同时保持单进程简单性。

---

## 二、整体架构

```
用户消息（QQBot）
      ↓
[Receptionist]              轻量路由层，规则匹配，不做 LLM 调用
      ↓ 按规则分发
┌─────────────────────────────────────────────────────┐
│                    Agent Pool                        │
│                                                      │
│  [Misc-1] ← 常驻，always-on                         │
│  [Misc-2] ← 按需，misc 配额第二个                    │
│  [Task-A] ← 按需，对应某个具体 Task                  │
│  [Task-B] ← 按需，对应另一个 Task                    │
│  ...                                                 │
│                                                      │
│  上限 6-8 个（可配置），闲置配额可跨类型借用           │
│  所有 Agent 共享 AgentRegistry（全局可见性）           │
│  Agent 间可直接发消息（in-process EventEmitter）      │
└─────────────────────────────────────────────────────┘
      ↓ 各自直接推结果
用户（QQBot）
```

**单进程**：所有 Agent 运行在同一 Node.js 进程，并发靠 async/await（LLM 调用是纯 I/O，事件循环天然支持多个请求同时在飞）。参考：Claw 和 Hermes 均为单进程模型。

---

## 三、核心组件

### 3.1 AgentRegistry（全局注册表）

内存单例，所有 Agent 可读写：

```typescript
interface AgentState {
  id: string                          // UUID
  type: 'misc' | 'task'
  taskId?: string                     // task agent 对应的 task
  taskTitle?: string                  // 人类可读的 task 名
  status: 'idle' | 'busy' | 'sleeping'
  currentWork?: string                // 正在处理的消息摘要（1句话）
  sessionId: string                   // 对应的 SQLite session
  createdAt: number
  lastActiveAt: number
}

class AgentRegistry {
  private agents: Map<string, AgentState>

  register(agent: AgentState): void
  unregister(agentId: string): void
  getAll(): AgentState[]
  getByTaskId(taskId: string): AgentState | undefined
  getAvailableMisc(): AgentState | undefined
  getSnapshot(): string              // 给 Agent context 用的简洁文本
}
```

`getSnapshot()` 返回类似：
```
Active agents:
- misc-1 [idle] 
- task-agent-7f2a [busy] Task: dragon-stock-api | "分析K线数据"
- task-agent-3b1c [busy] Task: geminiclaw-compaction | "实现Tool pair保护"
```

### 3.2 MessageBus（消息总线）

in-process，基于 EventEmitter：

```typescript
interface RoutedMessage {
  id: string                  // 消息 UUID，用于环路检测
  originalUserMessage: string
  fromAgentId?: string        // 转发链追踪（无则为 Receptionist）
  routeChain: string[]        // 已经过的 agentId 列表，防环
  sessionId: string           // 用户 session
  replyFn: (text: string) => Promise<void>  // 直接回 QQBot 的函数
}

class MessageBus extends EventEmitter {
  route(targetAgentId: string, msg: RoutedMessage): void
  // 发送前检查 routeChain 是否包含 targetAgentId → 包含则触发环路处理
}
```

**环路检测**：
```typescript
if (msg.routeChain.includes(targetAgentId)) {
  // 成环，停止转发，回告用户
  await msg.replyFn("我在尝试路由这条消息时遇到了循环，请直接告诉我你的意图")
  return
}
msg.routeChain.push(targetAgentId)
```

### 3.3 Receptionist（路由层）

不是独立 Agent，是一个轻量函数，在消息进来时执行：

```typescript
async function dispatchMessage(
  userMessage: string,
  replyFn: ReplyFn,
  registry: AgentRegistry,
  pool: AgentPool
): Promise<void> {
  // 1. 在 registry 里找 task agent，按 taskTitle/taskId 做 FTS 匹配
  const taskAgent = findMatchingTaskAgent(userMessage, registry)
  if (taskAgent && taskAgent.status !== 'busy') {
    return bus.route(taskAgent.id, buildMsg(userMessage, replyFn))
  }

  // 2. 没有匹配或 task agent 忙 → 路由到可用 misc agent
  const miscAgent = registry.getAvailableMisc()
    ?? await pool.spawnMisc()   // 在配额内创建新的
  
  if (miscAgent) {
    return bus.route(miscAgent.id, buildMsg(userMessage, replyFn))
  }

  // 3. 所有 agent 都满了 → 排队
  pool.enqueue({ userMessage, replyFn })
}
```

### 3.4 AgentPool（生命周期管理）

```typescript
class AgentPool {
  private config: {
    maxTotal: number          // 默认 8
    miscQuota: number         // 默认 2
    taskQuota: number         // 默认 6（maxTotal - miscQuota）
  }

  async spawnMisc(): Promise<Agent | null>
  async spawnTask(taskId: string): Promise<Agent | null>
  async idle(agentId: string): Promise<void>   // agent 完成工作后变 idle
  async destroy(agentId: string): Promise<void>

  // Buffer 借用机制（Spark Fair Scheduler 风格）
  // misc 满了但 task 有空闲 → misc 可借用 task 配额（低优先级）
  // 反之亦然
  // 如果被借用方突然有任务 → 抢回配额，被借用的 agent 在当前任务完成后不续
  private canBorrowFrom(requesterType: 'misc' | 'task'): boolean
}
```

### 3.5 Agent（单个 Actor）

每个 Agent 拥有：
- 独立 `AgentLoop` 实例（含独立 LLM 调用栈）
- 独立 SQLite session（对话历史隔离）
- 对 `AgentRegistry` 的读权限（知道其他人在干什么）
- 对 `MessageBus` 的写权限（可以转发消息给其他 Agent）
- 若干 Agent 专属工具（见第四节）

```typescript
class Agent {
  id: string
  type: 'misc' | 'task'
  taskId?: string
  private loop: AgentLoop
  private sessionId: string

  async handle(msg: RoutedMessage): Promise<void>
  // 1. 更新 registry（status=busy, currentWork）
  // 2. 把 registry snapshot 注入 system prompt（小上下文）
  // 3. 调 AgentLoop.run(msg.originalUserMessage)
  // 4. 结果直接 msg.replyFn(result)
  // 5. 更新 registry（status=idle）
  // 6. 检查 pool 是否有排队消息 → 继续处理
}
```

---

## 四、Agent 专属工具

Agent 除拥有现有 7 个工具外，额外注册以下 Agent Mesh 工具：

```typescript
// 查看其他 Agent 状态
agent_list_peers(): AgentState[]

// 查看其他 Agent 的对话历史（跨 session 查询）
agent_get_history(agentId: string, limit?: number): Message[]

// 把消息转发给另一个 Agent（带环路检测）
agent_route(targetAgentId: string, message: string): void

// 孵化新的 peer Agent（在配额内）
agent_spawn(type: 'misc' | 'task', taskId?: string): AgentId

// 声明任务切换（归档当前 task，接受新 task）
agent_switch_task(newTaskId: string, reason: string): void
```

---

## 五、Agent 任务切换逻辑

**Misc Agent 遇到新任务：**
```
优先派出去（在配额允许时 spawn 新 Task Agent）
保持自己 idle，继续接听用户消息
```

**Task Agent 遇到不相关消息：**
```
情况A：自己没有 Task → 自己承担（成为该新 Task 的 Agent）
情况B：有 Task 且进行中 → 转发给 misc 或 spawn 新 agent
情况C：有 Task 且已完成 → 调 agent_switch_task()，归档旧 Task，承担新 Task
```

**Task 归档**：旧 Task 状态写入 Task Manager（状态设为 paused/completed），
SQLite session 历史保留，新消息到来时按 Task Router 逻辑重新分配。

---

## 六、Buffer 借用机制

参考 Spark Fair Scheduler / YARN Capacity Scheduler：

```
misc 配额: 2    task 配额: 6    总上限: 8

场景：misc-1 busy，misc 想再开一个但 misc 配额用满了，task 还有空闲
→ misc 借用 task 的一个配额槽
→ 借来的 Agent 标记为 borrowed=true, borrowedBy='misc'
→ 如果 task 突然有新任务需要这个槽
  → 等借用 Agent 当前工作完成，不续，回收给 task 队列
  → 不强制打断（不杀正在工作的 Agent）
```

---

## 七、与现有系统的集成

```
现有：Channel → AgentLoop → MemoryStrategy（SQLite）
改后：Channel → Receptionist → AgentPool
                                  └── Agent（含 AgentLoop + SQLite session）
                                  └── Agent（含 AgentLoop + SQLite session）
                                  ...
```

- **Phase 1（SQLite）**：每个 Agent 用独立 sessionId，直接复用 SqliteStrategy，无需改动
- **Phase 2（Compaction）**：每个 Agent 的 AgentLoop 独立触发 Compaction，天然隔离
- **Phase 3（Task Manager）**：Task 路由依赖 Task Manager 的任务列表，两系统协同

---

## 八、实现阶段

```
Phase M1：AgentRegistry + MessageBus 骨架
  - AgentRegistry 内存单例
  - MessageBus EventEmitter + 环路检测
  - 最小化 Agent wrapper

Phase M2：AgentPool + Receptionist
  - 按需创建/销毁 Agent
  - 路由逻辑（FTS 匹配 + misc fallback）
  - Buffer 借用机制
  - 排队逻辑

Phase M3：Agent 专属工具
  - agent_list_peers / agent_get_history
  - agent_route（带环路检测）
  - agent_spawn / agent_switch_task

Phase M4：与 Task Manager 集成
  - Task 路由和 Agent 对应关系
  - Task 归档时通知 Pool 释放 Agent
```

---

## 九、配置

```yaml
agentMesh:
  enabled: true
  maxTotal: 8           # 总 Agent 上限
  miscQuota: 2          # misc agent 固有配额
  alwaysOnMisc: 1       # 常驻 misc agent 数量（启动即创建）
  idleTimeoutMs: 300000 # idle 超过 5 分钟则销毁（常驻 misc 除外）
  routeMaxHops: 10      # 单条消息最多转发次数（超出视为异常）
```

---

## 四、Named Agent（命名 Agent）

### 4.1 名字分配策略

**三层叠加：**
1. **默认**：预设中文名字池按顺序分配
   ```typescript
   const NAME_POOL = ['小张', '小王', '小李', '小赵', '小陈', '小刘', '小孙', '小周']
   ```
2. **任务型 AI 命名**：创建 Task Agent 时，可选让 haiku 根据 taskTitle 生成有意义名字（如"财经"）
3. **用户改名**：`/rename 小王 财经` 随时修改

### 4.2 回复前缀

所有 Agent 回复自动加前缀：
```
[财经] K线显示近期...
[小张] 好的，已记录...
```
系统切换 Agent 时主动告知：`[系统] 已切换到 小张`

### 4.3 Sticky Agent

用户命令：
- `我要跟小王对话` / `@小王` / `/talk 小王` → 设置 sticky
- `切换到杂项` / `/talk misc` → 切换到任意可用 misc
- `/talk off` → 取消 sticky

**持久化到 SQLite**（`user_preferences` 表），重启后恢复：
```sql
CREATE TABLE IF NOT EXISTS user_preferences (
  user_id   TEXT PRIMARY KEY,
  sticky_agent_name TEXT,
  updated_at INTEGER NOT NULL
);
```
注意：sticky 记录名字而非 ID（Agent 重建后名字复用，ID 会变）。

### 4.4 优先级规则

```
用户有 sticky → sticky idle → 直接路由
用户有 sticky → sticky busy → 告知用户，fallback 普通路由
无 sticky → 普通 Receptionist 路由逻辑
```

---

## 五、Agent 专属工具

```typescript
agent_list_peers(): AgentState[]
agent_get_history(agentId: string, limit?: number): Message[]
agent_route(targetAgentName: string, message: string): void
agent_spawn(type: 'misc' | 'task', taskId?: string, name?: string): AgentId
agent_switch_task(newTaskId: string, reason: string): void
```

---

## 六、Agent 任务切换逻辑

**Misc Agent 遇到新任务：**
优先 spawn 新 Task Agent，自己保持 idle 接听用户消息，始终保证 ≥1 misc idle。

**Task Agent 遇到不相关消息：**
- 无 Task → 自己承担
- Task 进行中 → 转发给 misc 或 spawn 新 agent
- Task 已完成 → `agent_switch_task()` 归档旧 Task，承担新 Task

---

## 七、Buffer 借用机制

参考 Spark Fair Scheduler：
```
misc 配额 2，task 配额 6，总上限 8
misc 满 + task 有空闲 → misc 借用 task 槽（borrowed=true）
task 需要槽 → 等借用 Agent 当前工作完成后回收，不强制打断
```

---

## 八、实现阶段

```
Phase M1：AgentRegistry + MessageBus    ✅ commit c4df2d5
Phase M2：AgentPool + Receptionist      🔄 进行中
  - 按需创建/销毁 Agent（含名字分配）
  - 路由逻辑（FTS 匹配 + misc fallback）
  - Buffer 借用机制 + 排队逻辑
  - Sticky Agent + user_preferences 表
  - /v1/mesh/status 端点

Phase M3：Agent 专属工具
Phase M4：与 Task Manager 集成
```

---

## 九、配置

```yaml
agentMesh:
  enabled: true
  maxTotal: 8
  miscQuota: 2
  alwaysOnMisc: 1
  idleTimeoutMs: 300000
  routeMaxHops: 10
  taskAgentAiNaming: true
```

---

## 十、验证命令

```bash
# 基础连通性
bash scripts/verify.sh

# 直接调用
ssh -p 6022 pingjiangli@49.232.173.252 \
  "curl -s http://127.0.0.1:18888/v1/agent/chat \
    -H 'Authorization: Bearer gemeniclaw-local-dev-token-2026' \
    -H 'Content-Type: application/json' \
    -d '{\"message\":\"你好\",\"session_id\":\"test-001\"}'"

# 查看 Mesh 状态（M2 完成后可用）
ssh -p 6022 pingjiangli@49.232.173.252 \
  "curl -s http://127.0.0.1:18888/v1/mesh/status \
    -H 'Authorization: Bearer gemeniclaw-local-dev-token-2026'"
```
