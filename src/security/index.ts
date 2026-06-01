/**
 * src/security/index.ts
 * Security Layer — 命令审批 + Secret 脱敏 + 路径安全 + Unicode 归一化
 *
 * 三层防线架构：
 *  Layer 1: Hardline Blocklist（无条件拒绝，不可覆盖）
 *  Layer 2: Dangerous Patterns（需审批的高危命令）
 *  Layer 3: Smart Approval（LLM 辅助风险评估，可选）
 *
 * 本模块通过 HookBus 的 pre_tool_call 事件接入 AgentLoop。
 */

export { CommandGuard, type GuardDecision, type GuardLevel } from "./command-guard.js"
export { SecretRedactor } from "./redaction.js"
export { PathValidator } from "./path-validator.js"
export { normalizeForDetection } from "./normalize.js"
