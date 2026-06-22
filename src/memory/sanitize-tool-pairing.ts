/**
 * sanitizeToolPairing — 修复 messages 中 tool_result/tool_use 配对问题
 *
 * Anthropic API 要求：每个 tool role 消息（tool_result）必须紧跟在
 * 包含对应 tool_use（tool_calls）的 assistant 消息之后。
 *
 * 当历史消息被截断时，可能出现：
 * 1. tool 消息出现在对应的 assistant(tool_calls) 之前（顺序反转）
 * 2. 孤立的 tool 消息（对应的 assistant 已被截掉）
 *
 * 本函数移除所有无法配对的 tool 消息，避免触发 mcli soft-error。
 */
export function sanitizeToolPairing(messages: any[]): any[] {
  // 收集所有已出现的 tool_call ids（从 assistant 消息的 tool_calls 中）
  const seenToolCallIds = new Set<string>();
  const result: any[] = [];

  for (const msg of messages) {
    if (msg.role === 'assistant' && msg.tool_calls) {
      // 记录这个 assistant 消息发起的所有 tool call ids
      for (const tc of msg.tool_calls) {
        if (tc.id) seenToolCallIds.add(tc.id);
      }
      result.push(msg);
    } else if (msg.role === 'tool') {
      // tool 消息必须有对应的前置 tool_call
      const toolCallId = msg.tool_call_id;
      if (toolCallId && seenToolCallIds.has(toolCallId)) {
        result.push(msg);
      } else {
        // 孤立的 tool_result，跳过
        console.warn("[sanitizeToolPairing] Removing orphan tool message (tool_call_id=" + toolCallId + ")");
      }
    } else {
      result.push(msg);
    }
  }

  if (result.length < messages.length) {
    console.warn("[sanitizeToolPairing] Removed " + (messages.length - result.length) + " orphan tool message(s)");
  }

  return result;
}
