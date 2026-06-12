/**
 * Skill-evolution engine — public exports.
 *
 * The Hermes-style skill-level self-evolution engine. Reflects on real
 * conversations and crystallises / refines reusable SKILL.md playbooks under
 * ~/.geminiclaw/skills/. Fully independent from the code engine (twin-system).
 */

export { SkillEvolutionEngine, DEFAULT_SKILL_EVOLUTION_CONFIG } from "./skill-evolution-engine.js"
export type {
  SkillEvolutionConfig,
  SkillEvolutionEngineDeps,
} from "./skill-evolution-engine.js"

export { SkillStore, slugifySkillName } from "./skill-store.js"
export type { Skill, SkillMeta, SkillStoreOptions } from "./skill-store.js"

export { SkillReflector, DEFAULT_REFLECTOR_CONFIG } from "./skill-reflector.js"
export type {
  ReflectionAction,
  ReflectionInput,
  ReflectionResult,
  SkillReflectorConfig,
} from "./skill-reflector.js"

export {
  ConversationCandidateSource,
  DEFAULT_CANDIDATE_CONFIG,
} from "./conversation-candidate-source.js"
export type {
  CandidateScanFilter,
  ConversationCandidateConfig,
} from "./conversation-candidate-source.js"

export type {
  LlmClient,
  LlmMessage,
  CandidateSource,
  ReflectionCandidate,
  SkillEngineLogger,
} from "./types.js"
