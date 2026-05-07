// src/evolution/preview-service.ts
// Generates before/after conversation comparisons for pending evolution intents.
// Called asynchronously after Mutator succeeds — never blocks the main flow.

import { randomUUID } from "crypto"
import type { EvolutionDB } from "./db.js"
import type { ProviderRouter } from "../providers/router.js"
import type { Intent, ConversationSample, EvolutionPreview } from "./types.js"
import type { Logger } from "./index.js"

const MAX_SAMPLES_PER_INTENT = 3
const SUMMARY_MAX_CHARS = 120

export interface PreviewServiceParams {
  db: EvolutionDB
  providerRouter: ProviderRouter
  logger: Logger
}

export class PreviewService {
  private db: EvolutionDB
  private providerRouter: ProviderRouter
  private logger: Logger

  constructor(params: PreviewServiceParams) {
    this.db = params.db
    this.providerRouter = params.providerRouter
    this.logger = params.logger
  }

  /**
   * Asynchronously generate previews for an intent.
   * Selects up to MAX_SAMPLES_PER_INTENT representative samples,
   * re-runs the LLM with the updated config, and stores results.
   */
  async generate(intent: Intent): Promise<void> {
    if (this.db.hasEvolutionPreview(intent.id)) {
      this.logger.info("[PreviewService] previews already exist for intent %s", intent.id)
      return
    }

    const samples = this.selectSamples(intent)
    if (samples.length === 0) {
      this.logger.info("[PreviewService] no samples available for intent %s", intent.id)
      return
    }

    this.logger.info(
      "[PreviewService] generating %d previews for intent %s",
      samples.length,
      intent.id
    )

    for (const sample of samples) {
      try {
        const afterReply = await this.rerun(sample.userMessage)
        const summary = await this.summarize(intent.description, sample.agentReply, afterReply)

        const preview: EvolutionPreview = {
          id: randomUUID(),
          intentId: intent.id,
          sampleId: sample.id,
          userMessage: sample.userMessage,
          beforeReply: sample.agentReply,
          afterReply,
          summary,
          generatedAt: Date.now(),
        }
        this.db.insertEvolutionPreview(preview)
        this.logger.info("[PreviewService] saved preview %s for intent %s", preview.id, intent.id)
      } catch (err) {
        this.logger.warn(
          "[PreviewService] failed to generate preview for sample %s: %s",
          sample.id,
          (err as Error).message
        )
      }
    }
  }

  // ---------------------------------------------------------------------------
  // Private helpers
  // ---------------------------------------------------------------------------

  /**
   * Select representative samples for comparison.
   * Priority: failure samples first, then most recent.
   */
  private selectSamples(_intent: Intent): ConversationSample[] {
    // Try failure samples first
    const failureSamples = this.db.listConversationSamples({ limit: 5, failureOnly: true })
    const recentSamples = this.db.listConversationSamples({ limit: 10 })

    // Merge: failures first, then fill with recent (no duplicates)
    const seen = new Set<string>()
    const merged: ConversationSample[] = []
    for (const s of [...failureSamples, ...recentSamples]) {
      if (!seen.has(s.id)) {
        seen.add(s.id)
        merged.push(s)
      }
      if (merged.length >= MAX_SAMPLES_PER_INTENT) break
    }
    return merged
  }

  /**
   * Re-run the LLM with the user message to get the "after" reply.
   */
  private async rerun(userMessage: string): Promise<string> {
    const response = await this.providerRouter.chat([
      { role: "user", content: userMessage },
    ])
    return response.content
  }

  /**
   * Ask the LLM to generate a one-line summary of the improvement.
   */
  private async summarize(
    intentDescription: string,
    beforeReply: string,
    afterReply: string
  ): Promise<string> {
    const prompt = `You are summarizing an AI agent improvement. In one sentence (max ${SUMMARY_MAX_CHARS} chars), describe what changed between the before and after replies, in the context of the intent.

Intent: ${intentDescription}

Before reply (first 300 chars): ${beforeReply.slice(0, 300)}

After reply (first 300 chars): ${afterReply.slice(0, 300)}

Reply with ONLY the one-sentence summary, no quotes, no punctuation at end.`

    const response = await this.providerRouter.chat([
      { role: "user", content: prompt },
    ])
    return response.content.trim().slice(0, SUMMARY_MAX_CHARS)
  }
}
