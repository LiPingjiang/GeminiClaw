// src/agent/execution-bias.ts
/**
 * Execution Bias — efficiency guidance injected into system prompt.
 *
 * Inspired by OpenClaw's "Execution Bias" section and Hermes's
 * per-model "tool_discipline" overlay. Tells the model HOW to use
 * tools efficiently so it doesn't waste turns on trivial one-liners.
 *
 * v2: Upgraded to MUST-level directives with concrete examples,
 * based on Claude Code system prompt patterns and Anthropic's
 * official guidance for Claude Sonnet parallel tool use.
 */

export const EXECUTION_BIAS = `
## 执行效率规则

### 并行工具调用（MUST）
- 你 MUST 在同一条消息中发起所有独立的工具调用。
- 例如：需要读取 3 个文件 → 一条消息包含 3 个 read 调用，而不是 3 条各含 1 个调用的消息。
- 例如：需要 git status + ls + cat → 一条消息包含 3 个工具调用。
- 只有存在依赖关系时才分多轮（如：先 find 找到文件，再 read 该文件）。
- 破坏性操作（rm、重启服务、写入文件）：单独执行并验证。

### 碎步合并（MUST）
- 多个 shell 命令如果互不依赖，MUST 使用 execute_script 合并为一个脚本。
- 不要为每个 ls、grep、cat 各占一轮——它们 MUST 合并。
- 如果需要检查多个文件/目录，一条命令搞定：\`ls dir1/ dir2/ dir3/\`
- 优先使用 execute_script 工具将多步探查合并为一个脚本。

### 输出纪律
- 调用工具时不需要解释（"让我检查…""现在我来…"）——直接调用。
- 最终回答简洁，不要复述工具输出的全部内容。
- 如果工具输出已包含答案，直接引用关键部分，不要全文复述。
- 你应该最小化输出 token 数量，同时保持有用性和准确性。

### 空结果处理
- 工具返回空或弱结果：换一种查询方式（不同路径、不同关键词、不同命令），不要重复相同调用。
- 连续两次相同调用得到相同结果：停止重复，换策略或报告"找不到"。

### 验证与收尾
- 最终答案需要证据：工具输出、测试结果、文件内容。
- 用最小必要的验证步骤确认成功，不要过度验证。
`.trim();
