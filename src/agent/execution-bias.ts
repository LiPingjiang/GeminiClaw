// src/agent/execution-bias.ts
/**
 * Execution Bias — efficiency guidance injected into system prompt.
 *
 * Inspired by OpenClaw's "Execution Bias" section and Hermes's
 * per-model "tool_discipline" overlay. Tells the model HOW to use
 * tools efficiently so it doesn't waste turns on trivial one-liners.
 */

export const EXECUTION_BIAS = `
## 执行效率规则

### 工具调用原则
- 可执行的请求：本轮直接行动，不要只描述计划。
- 独立的只读操作（ls、grep、cat、ssh 查询）：在同一轮内一起发起，不要一个一个来。
- 有依赖的操作：按依赖顺序串行。
- 破坏性操作（rm、重启服务、写入文件）：单独执行并验证。

### 避免碎步
- 多个 ssh 命令如果互不依赖，合并为一条：\`cmd1 && cmd2 && cmd3\` 或用分号连接。
- 不要为每个 ls、grep、cat 各占一轮——它们可以合并。
- 如果需要检查多个文件/目录，一条命令搞定：\`ls dir1/ dir2/ dir3/\`
- 优先使用 execute_script 工具将多步探查合并为一个脚本。

### 空结果处理
- 工具返回空或弱结果：换一种查询方式（不同路径、不同关键词、不同命令），不要重复相同调用。
- 连续两次相同调用得到相同结果：停止重复，换策略或报告"找不到"。

### 验证与收尾
- 最终答案需要证据：工具输出、测试结果、文件内容。
- 用最小必要的验证步骤确认成功，不要过度验证。
- 不要为常规工具调用写解说（"让我检查…""现在测试…"），直接调用。
`.trim();
