// @ts-nocheck
// src/evolution/preview-service.ts
// Generates before/after conversation comparisons for pending evolution intents.
// Called asynchronously after Mutator succeeds — never blocks the main flow.
import { randomUUID } from "crypto";
const MAX_SAMPLES_PER_INTENT = 3;
const SUMMARY_MAX_CHARS = 120;
export class PreviewService {
    db;
    providerRouter;
    logger;
    constructor(params) {
        this.db = params.db;
        this.providerRouter = params.providerRouter;
        this.logger = params.logger;
    }
    /**
     * Asynchronously generate previews for an intent.
     * Selects up to MAX_SAMPLES_PER_INTENT representative samples,
     * re-runs the LLM with the updated config, and stores results.
     */
    async generate(intent) {
        if (this.db.hasEvolutionPreview(intent.id)) {
            this.logger.info("[PreviewService] previews already exist for intent %s", intent.id);
            return;
        }
        const samples = this.selectSamples(intent);
        if (samples.length === 0) {
            this.logger.info("[PreviewService] no samples available for intent %s", intent.id);
            return;
        }
        this.logger.info("[PreviewService] generating %d previews for intent %s", samples.length, intent.id);
        for (const sample of samples) {
            try {
                const afterReply = await this.rerun(sample.userMessage);
                const summary = await this.summarize(intent.description, sample.agentReply, afterReply);
                const preview = {
                    id: randomUUID(),
                    intentId: intent.id,
                    sampleId: sample.id,
                    userMessage: sample.userMessage,
                    beforeReply: sample.agentReply,
                    afterReply,
                    summary,
                    generatedAt: Date.now(),
                };
                this.db.insertEvolutionPreview(preview);
                this.logger.info("[PreviewService] saved preview %s for intent %s", preview.id, intent.id);
            }
            catch (err) {
                this.logger.warn("[PreviewService] failed to generate preview for sample %s: %s", sample.id, err.message);
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
    selectSamples(_intent) {
        // Try failure samples first
        const failureSamples = this.db.listConversationSamples({ limit: 5, failureOnly: true });
        const recentSamples = this.db.listConversationSamples({ limit: 10 });
        // Merge: failures first, then fill with recent (no duplicates)
        const seen = new Set();
        const merged = [];
        for (const s of [...failureSamples, ...recentSamples]) {
            if (!seen.has(s.id)) {
                seen.add(s.id);
                merged.push(s);
            }
            if (merged.length >= MAX_SAMPLES_PER_INTENT)
                break;
        }
        return merged;
    }
    /**
     * Re-run the LLM with the user message to get the "after" reply.
     */
    async rerun(userMessage) {
        const response = await this.providerRouter.chat([
            { role: "user", content: userMessage },
        ]);
        return response.content;
    }
    /**
     * Ask the LLM to generate a one-line summary of the improvement.
     */
    async summarize(intentDescription, beforeReply, afterReply) {
        const prompt = `You are summarizing an AI agent improvement. In one sentence (max ${SUMMARY_MAX_CHARS} chars), describe what changed between the before and after replies, in the context of the intent.

Intent: ${intentDescription}

Before reply (first 300 chars): ${beforeReply.slice(0, 300)}

After reply (first 300 chars): ${afterReply.slice(0, 300)}

Reply with ONLY the one-sentence summary, no quotes, no punctuation at end.`;
        const response = await this.providerRouter.chat([
            { role: "user", content: prompt },
        ]);
        return response.content.trim().slice(0, SUMMARY_MAX_CHARS);
    }
}
