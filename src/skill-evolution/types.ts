/**
 * Skill-evolution shared types.
 *
 * Kept local to this directory so the skill engine has no compile-time
 * dependency on twin-system internals — the two engines stay decoupled.
 */

export interface LlmMessage {
  role: "system" | "user" | "assistant"
  content: string
}

/** Minimal LLM client contract the skill engine needs. */
export interface LlmClient {
  chat(messages: LlmMessage[]): Promise<string>
}

/** A conversation flagged as worth reflecting on. */
export interface ReflectionCandidate {
  sessionId: string
  title: string
  /** Problem reasons from conversation analysis. */
  problems: string[]
  /** Rendered transcript sample. */
  transcript: string
  /** Problem score (higher = more worth reflecting on). */
  score: number
}

/** Source that supplies conversations to reflect on. */
export interface CandidateSource {
  /** Produce a batch of reflection candidates. */
  collect(): ReflectionCandidate[] | Promise<ReflectionCandidate[]>
}

export interface SkillEngineLogger {
  info(msg: string, ...args: unknown[]): void
  warn(msg: string, ...args: unknown[]): void
  error(msg: string, ...args: unknown[]): void
}
