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
  /**
   * Optional task provenance. When a long session is decomposed into N
   * independent tasks (see SessionTaskSegmenter), each task becomes its own
   * candidate carrying these fields. Absent for whole-session candidates, so
   * the structure stays backward compatible.
   */
  task?: {
    /** 1-based task index within the originating session. */
    index: number
    /** Total tasks the session was split into. */
    total: number
    /** Short task title from segmentation. */
    title: string
    /** One-line task goal from segmentation. */
    summary: string
    /** Inclusive message-id range of this task within the session. */
    startId: number
    endId: number
  }
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
