# Context Management — API 约束与历史消息处理

## Anthropic Messages API: tool_use / tool_result 配对规范

### 强制约束

Anthropic Messages API 对工具调用消息有以下**硬性规则**，违反任何一条会导致 400 错误或 soft-error：

1. **每个 tool_use 必须有对应的 tool_result** — assistant 消息中的每个 tool_use block 必须在紧随其后的 user 消息中有匹配的 tool_result
2. **ID 一一匹配** — tool_result.tool_use_id 必须精确匹配前面 tool_use.id
3. **顺序不可逆** — tool_result 必须出现在对应 tool_use 之后
4. **不能有孤立的 tool_result** — 如果 tool_result 引用的 tool_use_id 在历史中不存在，API 拒绝
5. **同一角色不能连续** — user->user 或 assistant->assistant 是非法的

### 状态机模型

    S0: assistant_generating
        -> 输出 text block: 仍在 S0
        -> 输出 tool_use block: 进入 S1
        -> stop_reason = end_turn: 本轮完成

    S1: tool_use_pending
        -> stop_reason = tool_use
        -> 应用层执行所有工具
        -> 进入 S2

    S2: awaiting_tool_result
        -> 下一条消息必须是 user
        -> user.content 开头必须包含对应 tool_result block
        -> 每个 tool_result.tool_use_id 必须匹配一个未闭合的 tool_use.id
        -> 所有 pending tool_use 闭合后进入 S3

    S3: continue_generation
        -> 把闭合后的历史发送给模型
        -> 模型基于工具结果继续 text 或再次 tool_use

### OpenAI 兼容格式的等价约束

GeminiClaw 使用 OpenAI 兼容格式（通过 mcli proxy 转发到 Anthropic），对应关系：

- Anthropic assistant content 中的 tool_use block = OpenAI assistant 消息的 tool_calls[] 数组
- Anthropic user content 中的 tool_result block = OpenAI role:tool 消息 + tool_call_id
- tool_use.id = tool_calls[].id
- tool_result.tool_use_id = tool 消息的 tool_call_id

约束完全相同：每个 role:tool 消息必须出现在包含对应 tool_calls[].id 的 assistant 消息之后。

---

## 历史截断导致的配对问题

### 问题场景

当从 DB 加载历史消息时（SELECT ... ORDER BY id DESC LIMIT N, 然后 reverse()），
截断可能发生在 tool_use/tool_result 对的中间：

    [被截掉] assistant { tool_calls: [{ id: "call_abc" }] }
    [被保留] tool { tool_call_id: "call_abc", content: "..." }   <- 孤立!
    [被保留] assistant { content: "基于工具结果..." }
    [被保留] user { content: "下一个问题" }

### 解决方案

src/memory/sanitize-tool-pairing.ts 中的 sanitizeToolPairing() 函数：

1. 顺序扫描 messages 数组
2. 遇到 assistant + tool_calls 时，记录所有 tool_call.id 到 seenToolCallIds
3. 遇到 role:tool 时，检查其 tool_call_id 是否在 seenToolCallIds 中
4. 如果不在（孤立），移除该消息
5. 在 agentLoop.run() 调用前执行

### 调用位置

src/channels/qqbot/index.ts — 在 context 组装完成后、传入 agentLoop 前：

    const sanitizedMessages = sanitizeToolPairing(messages);
    for await (const event of agentLoop.run({
      messages: sanitizedMessages,
      ...
    })) { ... }

---

## 参考

- Anthropic Messages API 文档: https://docs.anthropic.com/en/docs/build-with-claude/tool-use
- Claude Code 内部实现: repairToolUseResultPairing() — 同样的逻辑，额外还会为缺失 tool_result 的 tool_use 插入 synthetic error result
- 相关 commit: 5674911 fix(context): sanitize orphan tool_result messages before sending to LLM

---

## 未来改进方向

1. **为缺失 tool_result 的 tool_use 插入 synthetic error** — 当截断把 tool_result 截掉但保留了 assistant(tool_calls) 时，需要补一个 { role: "tool", tool_call_id: "...", content: "[context truncated]" }
2. **截断时感知 tool 对边界** — 在 DB 查询阶段就避免在 tool_use/tool_result 对中间截断
3. **角色连续性检查** — 确保不会出现 user->user 或 assistant->assistant 的情况
