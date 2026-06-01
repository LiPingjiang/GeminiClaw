/**
 * src/evolution/knowledge/index.ts
 * Knowledge Evolution Layer — 模块入口
 *
 * 三层进化架构：
 *  Layer 1: BackgroundReviewer — 每 turn 实时学习
 *  Layer 2: Curator — 定期知识整理（prefix clustering + umbrella）
 *  Layer 3: (existing) Code Evolution — GeminiClaw 独有的代码级自改
 *
 * 本模块实现 Layer 1 + Layer 2，与现有代码进化并列。
 */

export { KnowledgeStore, type KnowledgeEntry, type KnowledgeCategory, type KnowledgeStatus, type KnowledgeQuery } from "./store.js"
export { BackgroundReviewer, type ReviewerConfig, type TurnContext, type ChatFunction } from "./background-review.js"
export { Curator, type CuratorConfig, type CurationReport, type CurationAction } from "./curator.js"
export { buildReviewSystemPrompt, buildReviewUserMessage, parseReviewResponse, ANTI_PATTERNS, LEARNING_PRIORITIES, type ReviewResult } from "./rubric.js"
export { registerKnowledgeHooks, recordTurn, type KnowledgeHookOptions, type KnowledgeHookContext } from "./hook.js"
export { KnowledgeIntentSource, type IntentCandidate, type KnowledgeIntentSourceConfig, DEFAULT_KNOWLEDGE_INTENT_CONFIG } from "./intent-source.js"
export { EvolutionBridge, type EvolutionBridgeConfig, type BridgeStats, DEFAULT_BRIDGE_CONFIG } from "./evolution-bridge.js"
