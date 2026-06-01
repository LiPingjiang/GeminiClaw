// @ts-nocheck
// src/evolution/index.ts
// EvolutionEngine — Phase C implementation.
import { mkdirSync } from "fs";
import { execSync } from "child_process";
import { join } from "path";
import { TraceCollector } from "./trace/collector.js";
import { Mutator } from "./mutator/mutator.js";
import { Validator } from "./validator/validator.js";
import { Switcher } from "./switcher/switcher.js";
import { CircuitBreaker } from "./circuit-breaker/circuit-breaker.js";
import { IntentEngine } from "./intent/engine-with-skills.js";
import { RitualHandler } from "./ritual-handler.js";
import { DEFAULT_EVOLUTION_CONFIG, } from "./types.js";
import { ConversationStore } from "./conversation-store.js";
import { PreviewService } from "./preview-service.js";
const defaultLogger = {
    info: (msg, ...args) => console.log(`[EvolutionEngine] ${msg}`, ...args),
    warn: (msg, ...args) => console.warn(`[EvolutionEngine] WARN ${msg}`, ...args),
    error: (msg, ...args) => console.error(`[EvolutionEngine] ERROR ${msg}`, ...args),
};
export class EvolutionEngine {
    db;
    providerRouter;
    repoRoot;
    config;
    logger;
    traceCollector;
    mutator;
    validator;
    switcher;
    circuitBreaker;
    intentEngine;
    running = false;
    _evolving = false;
    idleTimer = null;
    lastMessageAt = 0;
    lastRunAt = 0;
    tracesSinceLastRun = 0;
    conversationStore;
    previewService;
    _ritualHandler = null;
    constructor(params) {
        this.db = params.db;
        this.providerRouter = params.providerRouter;
        this.repoRoot = params.repoRoot;
        this.logger = params.logger ?? defaultLogger;
        this.config = {
            ...DEFAULT_EVOLUTION_CONFIG,
            ...params.config,
            validator: {
                ...DEFAULT_EVOLUTION_CONFIG.validator,
                ...(params.config?.validator ?? {}),
            },
            mutator: {
                ...DEFAULT_EVOLUTION_CONFIG.mutator,
                ...(params.config?.mutator ?? {}),
            },
            circuitBreaker: {
                ...DEFAULT_EVOLUTION_CONFIG.circuitBreaker,
                ...(params.config?.circuitBreaker ?? {}),
            },
            background: {
                ...DEFAULT_EVOLUTION_CONFIG.background,
                ...(params.config?.background ?? {}),
            },
        };
        this.traceCollector = new TraceCollector(this.db);
        this.mutator = new Mutator({
            providerRouter: this.providerRouter,
            repoRoot: this.repoRoot,
            config: this.config.mutator,
            logger: this.logger,
        });
        this.validator = new Validator({
            repoRoot: this.repoRoot,
            config: this.config.validator,
            logger: this.logger,
            db: this.db,
        });
        this.switcher = new Switcher({
            repoRoot: this.repoRoot,
            db: this.db,
            logger: this.logger,
        });
        this.circuitBreaker = new CircuitBreaker({
            db: this.db,
            switcher: this.switcher,
            config: this.config.circuitBreaker,
            logger: this.logger,
        });
        this.intentEngine = new IntentEngine({
            db: this.db,
            providerRouter: this.providerRouter,
            repoRoot: this.repoRoot,
            memoryDbPath: params.memoryDbPath ?? "",
            skillsDir: join(this.repoRoot, "skills"),
            upstreamRepos: params.upstreamRepos ?? [],
        });
        this.conversationStore = new ConversationStore(this.db);
        this.previewService = new PreviewService({
            db: this.db,
            providerRouter: this.providerRouter,
            logger: this.logger,
        });
    }
    // -------------------------------------------------------------------------
    // Lifecycle
    // -------------------------------------------------------------------------
    /**
     * Initialize DB tables and seed slot_state if not already present.
     * Called once at startup from src/index.ts.
     */
    async start() {
        if (this.running)
            return;
        this.running = true;
        // Ensure data directory exists
        const dataDir = join(this.repoRoot, this.config.dataDir);
        mkdirSync(dataDir, { recursive: true });
        // Seed slot_state with initial values if the table is empty
        const slotA = this.db.getSlotState("a");
        if (!slotA) {
            this.db.upsertSlotState({
                slotId: "a",
                role: "active",
                buildHash: "",
                builtAt: 0,
                lastActivatedAt: Date.now(),
            });
        }
        const slotB = this.db.getSlotState("b");
        if (!slotB) {
            this.db.upsertSlotState({
                slotId: "b",
                role: "standby",
                buildHash: "",
                builtAt: 0,
            });
        }
        this.logger.info("started (dataDir=%s)", dataDir);
        this.startIdleLoop();
    }
    async stop() {
        if (!this.running)
            return;
        this.running = false;
        if (this.idleTimer) {
            clearInterval(this.idleTimer);
            this.idleTimer = null;
        }
        this.circuitBreaker.stopMonitoring();
        this.logger.info("stopped");
    }
    // -------------------------------------------------------------------------
    // Idle-triggered auto-evolution
    // -------------------------------------------------------------------------
    /**
     * Called by the chat route after each conversation turn completes.
     * Records that new data is available and updates the last-message timestamp.
     */
    onTraceRecorded() {
        this.tracesSinceLastRun++;
        this.lastMessageAt = Date.now();
    }
    /**
     * Three-gate check (all must pass before auto-running):
     *   1. Idle gate   — no message for idleThresholdMs (user not in active chat)
     *   2. Cooldown    — enough time since last runOnce
     *   3. Has data    — new traces since last run OR pending intents in queue
     */
    shouldRunNow() {
        const now = Date.now();
        const { idleThresholdMs, cooldownMs } = this.config.background;
        const isIdle = (now - this.lastMessageAt) > idleThresholdMs;
        const cooledDown = (now - this.lastRunAt) > cooldownMs;
        const hasPendingIntents = this.db.listIntents({ status: "pending" }).length > 0;
        const hasData = this.tracesSinceLastRun > 0 || hasPendingIntents;
        if (this._evolving) return false;
        return isIdle && cooledDown && hasData;
    }
    /**
     * Start the background idle loop. Checks every tickIntervalMs whether
     * conditions are met; if so, fires runOnce() asynchronously.
     */
    startIdleLoop() {
        const { tickIntervalMs } = this.config.background;
        this.idleTimer = setInterval(() => {
            if (!this.shouldRunNow())
                return;
            this.logger.info("[idle-loop] conditions met — triggering runOnce");
            void this.runOnce().then(result => {
                this.lastRunAt = Date.now();
                this.tracesSinceLastRun = 0;
                if (result.skipped) {
                    this.logger.info("[idle-loop] runOnce skipped: %s", result.skipReason);
                }
                else {
                    this.logger.info("[idle-loop] runOnce completed for intent %s", result.intentId);
                }
            }).catch(err => {
                this.logger.error("[idle-loop] runOnce error: %s", err.message);
            });
        }, tickIntervalMs);
    }
    // -------------------------------------------------------------------------
    // TraceCollector accessor (used by chat route)
    // -------------------------------------------------------------------------
    getTraceCollector() {
        return this.traceCollector;
    }
    // -------------------------------------------------------------------------
    // Phase C: Core evolution cycle with CircuitBreaker + Level 2
    // -------------------------------------------------------------------------
    /**
     * Run one full evolution cycle:
     *   1. CircuitBreaker.canEvolve() check
     *   2. Pick the first pending intent from DB
     *   3. Create evolution branch
     *   4. Mutator.mutate()
     *   5. If lowConfidence, escalate riskLevel
     *   6. Validator.validate() — Level 1
     *   7. If Level 1 passed and traces sufficient, run Level 2
     *   8. If both pass and riskLevel=low → auto switch + start CircuitBreaker monitoring
     *   9. If riskLevel=medium/high → return { needsApproval: true }
     *  10. Update intent status
     */
    async runOnce() {
        if (this._evolving) {
            this.logger.warn("[runOnce] already running — skipping");
            return { validationResults: [], skipped: true, skipReason: "already running" };
        }
        this._evolving = true;
        try {
        return await this._runOnceInner();
        } finally {
            this._evolving = false;
            // Always return to main after evolution attempt
            try { execSync("git checkout main", { cwd: this.repoRoot, stdio: "pipe", timeout: 10000 }); } catch (e) { this.logger.warn("[runOnce] checkout main failed: %s", e.message); }
        }
    }
    async _runOnceInner() {
        // Auto-generate intents if queue is empty
        const existingPending = this.db.listIntents({ status: "pending" });
        if (existingPending.length === 0) {
            const generated = await this.intentEngine.generateIntents();
            if (generated > 0) {
                this.logger.info("IntentEngine generated %d new intents", generated);
            }
        }
        // Also recover intents stuck in in_progress/validating (e.g. after a crash/restart)
        const stuckIntents = this.db.listIntents({ status: "in_progress" });
        for (const stuck of stuckIntents) {
            this.logger.warn("Recovering stuck intent %s (in_progress → pending)", stuck.id);
            this.db.updateIntentStatus(stuck.id, "pending");
        }
        const stuckValidating = this.db.listIntents({ status: "validating" });
        for (const stuck of stuckValidating) {
            this.logger.warn("Recovering stuck intent %s (validating → pending)", stuck.id);
            this.db.updateIntentStatus(stuck.id, "pending");
        }
        const pendingIntents = this.db.listIntents({ status: "pending" });
        if (pendingIntents.length === 0) {
            return {
                validationResults: [],
                skipped: true,
                skipReason: "no pending intents",
            };
        }
        const intent = pendingIntents[0];
        this.logger.info("Processing intent %s: %s", intent.id, intent.description);
        // Step 1: CircuitBreaker check
        const cbCheck = this.circuitBreaker.canEvolve(intent.targetFiles);
        if (!cbCheck.allowed) {
            this.logger.warn("Evolution blocked by CircuitBreaker for intent %s: %s", intent.id, cbCheck.reason);
            return {
                intentId: intent.id,
                validationResults: [],
                skipped: true,
                skipReason: `CircuitBreaker blocked: ${cbCheck.reason}`,
            };
        }
        // Mark in-progress
        this.db.updateIntentStatus(intent.id, "in_progress");
        let branchName;
        try {
            branchName = this.switcher.createEvolutionBranch(intent.id);
        }
        catch (err) {
            const error = err.message;
            this.logger.error("Failed to create evolution branch: %s", error);
            this.db.updateIntentStatus(intent.id, "rejected");
            return {
                intentId: intent.id,
                validationResults: [],
                skipped: false,
                skipReason: `Failed to create branch: ${error}`,
            };
        }
        // Mutate
        const mutationResult = await this.mutator.mutate(intent);
        if (!mutationResult.success) {
            this.logger.warn("Mutation failed for intent %s: %s", intent.id, mutationResult.error);
            this.db.updateIntentStatus(intent.id, "rejected");
            return {
                intentId: intent.id,
                mutationResult,
                validationResults: [],
                skipped: false,
                skipReason: `Mutation failed: ${mutationResult.error}`,
            };
        }
        // Check confidence — escalate risk if below threshold
        let effectiveIntent = intent;
        if (mutationResult.confidence.score < this.config.mutator.confidenceThreshold) {
            this.logger.warn("Low confidence (%.2f < %.2f) for intent %s — escalating risk level", mutationResult.confidence.score, this.config.mutator.confidenceThreshold, intent.id);
            effectiveIntent = this.escalateRisk(intent);
        }
        // Validate (Level 1)
        this.db.updateIntentStatus(intent.id, "validating");
        const level1Result = await this.validator.validate(effectiveIntent);
        const validationResults = [level1Result];
        if (!level1Result.passed) {
            this.logger.warn("Level 1 validation failed for intent %s", intent.id);
            this.db.updateIntentStatus(intent.id, "rejected");
            return {
                intentId: intent.id,
                mutationResult,
                validationResults,
                skipped: false,
            };
        }
        // Level 2 validation (if traces are sufficient)
        const traceCount = this.db.countTraces();
        if (traceCount >= 3) {
            this.logger.info("Running Level 2 validation for intent %s", intent.id);
            const level2Result = await this.validator.validateLevel2(effectiveIntent);
            validationResults.push(level2Result);
            if (!level2Result.passed && !level2Result.skipped) {
                this.logger.warn("Level 2 validation failed for intent %s: %s", intent.id, level2Result.reason);
                this.db.updateIntentStatus(intent.id, "rejected");
                return {
                    intentId: intent.id,
                    mutationResult,
                    validationResults,
                    skipped: false,
                };
            }
        }
        else {
            this.logger.info("Skipping Level 2 validation for intent %s: insufficient traces (%d < 3)", intent.id, traceCount);
        }
        // All intents require user approval — no auto-switch regardless of risk level
        this.logger.info("Intent %s queued for user approval (riskLevel=%s)", intent.id, effectiveIntent.riskLevel);
        this.db.updateIntentStatus(intent.id, "approved"); // awaiting manual switch via ritual
        this.db.insertPendingReview({
            intentId: intent.id,
            description: effectiveIntent.description,
            targetFiles: effectiveIntent.targetFiles,
            riskLevel: effectiveIntent.riskLevel,
            status: "pending",
            requestedAt: Date.now(),
        });
        // Asynchronously generate before/after previews (non-blocking)
        setImmediate(() => {
            void this.previewService.generate(effectiveIntent).catch(err => {
                this.logger.warn("[runOnce] PreviewService.generate failed: %s", err.message);
            });
        });
        return {
            intentId: intent.id,
            mutationResult,
            validationResults,
            skipped: false,
            skipReason: `Queued for user approval (riskLevel=${effectiveIntent.riskLevel})`,
        };
    }
    /**
     * Manually trigger a slot switch (for medium/high-risk intents waiting on human).
     * Finds the current evolution branch and switches to main.
     */
    async manualSwitch() {
        const currentBranch = this.switcher.getCurrentBranch();
        if (!currentBranch.startsWith("evolution/")) {
            // Not on an evolution branch — look for approved intents
            const approvedIntents = this.db.listIntents({ status: "approved" });
            if (approvedIntents.length === 0) {
                return {
                    success: false,
                    fromSlot: "b",
                    toSlot: "a",
                    error: "No approved intents found and not on an evolution branch",
                };
            }
            const intent = approvedIntents[0];
            const branchName = `evolution/${intent.id}`;
            const result = await this.switcher.switch(branchName, intent);
            if (result.success) {
                this.circuitBreaker.startMonitoring(intent.id);
            }
            return result;
        }
        // Currently on an evolution branch — find the intent
        const intentId = currentBranch.replace("evolution/", "");
        const intent = this.db.getIntent(intentId);
        if (!intent) {
            return {
                success: false,
                fromSlot: "b",
                toSlot: "a",
                error: `No intent found for branch ${currentBranch}`,
            };
        }
        const result = await this.switcher.switch(currentBranch, intent);
        if (result.success) {
            this.circuitBreaker.startMonitoring(intentId);
        }
        return result;
    }
    /**
     * Approve a high-risk intent that is waiting for human review.
     */
    async rejectIntent(intentId, reason) {
        const reviews = this.db.listPendingReviews();
        const review = reviews.find(r => r.intentId === intentId);
        if (!review) {
            throw new Error(`No pending review found for intent ${intentId}`);
        }
        this.db.resolvePendingReview(intentId, "rejected", reason);
        this.db.updateIntentStatus(intentId, "rejected");
        this.logger.info("Intent %s rejected: %s", intentId, reason);
    }
    async approveIntent(intentId, reviewer) {
        const review = this.db.getPendingReview(intentId);
        if (!review) {
            throw new Error(`No pending review found for intent ${intentId}`);
        }
        this.db.updatePendingReview(intentId, {
            status: "approved",
            reviewer,
            resolvedAt: Date.now(),
        });
        this.db.updateIntentStatus(intentId, "approved");
        this.logger.info("intent %s approved by %s", intentId, reviewer);
    }
    /** Manually trigger intent generation from all sources. */
    async generateIntents() {
        return this.intentEngine.generateIntents();
    }
    /** Add a user-triggered intent. Returns the new intent id. */
    addUserIntent(params) {
        return this.intentEngine.addUserIntent(params);
    }
    /**
     * Get current engine status.
     */
    async getStatus() {
        const slotA = this.db.getSlotState("a");
        const slotB = this.db.getSlotState("b");
        const activeSlot = slotA?.role === "active" ? "a" : "b";
        const standbySlot = activeSlot === "a" ? "b" : "a";
        const pendingIntents = this.db.listIntents({ status: "pending" });
        const lastEvolution = this.db.getLastEvolutionRecord();
        const lastUpstreamCheck = this.db.getLastUpstreamCheck();
        const traceCount = this.db.countTraces();
        void slotB; // referenced above, suppress unused warning
        return {
            enabled: this.config.enabled,
            activeSlot,
            standbySlot,
            pendingIntents: pendingIntents.length,
            lastEvolution: lastEvolution ?? undefined,
            lastUpstreamCheck: lastUpstreamCheck ?? undefined,
            traceCount,
        };
    }
    /**
     * Get evolution history.
     */
    async getHistory(limit = 20) {
        return this.db.listEvolutionHistory(limit);
    }
    // -------------------------------------------------------------------------
    // Internal helpers
    // -------------------------------------------------------------------------
    /** @internal */
    getDb() {
        return this.db;
    }
    getConversationStore() {
        return this.conversationStore;
    }
    /** @internal */
    getConfig() {
        return this.config;
    }
    /** @internal */
    getProviderRouter() {
        return this.providerRouter;
    }
    /** @internal */
    getRepoRoot() {
        return this.repoRoot;
    }
    /** @internal */
    getMutator() {
        return this.mutator;
    }
    /** @internal */
    getValidator() {
        return this.validator;
    }
    /** @internal */
    getSwitcher() {
        return this.switcher;
    }
    /** @internal */
    getCircuitBreaker() {
        return this.circuitBreaker;
    }
    /** Returns a simple intent classifier for slash commands. */
    getIntentClassifier() {
        return {
            classify: async (message) => {
                const text = message.trim();
                if (text === '/进化')
                    return { intent: 'evolve' };
                const show = text.match(/^\/进化\s+预览\s+(\d+)$/);
                if (show)
                    return { intent: 'evolve_show', index: parseInt(show[1], 10) };
                const confirm = text.match(/^\/进化\s+确认\s+(\d+)$/);
                if (confirm)
                    return { intent: 'evolve_confirm', index: parseInt(confirm[1], 10) };
                const reject = text.match(/^\/进化\s+拒绝\s+(\d+)$/);
                if (reject)
                    return { intent: 'evolve_reject', index: parseInt(reject[1], 10) };
                return { intent: 'none' };
            },
        };
    }
    /** Returns the RitualHandler for managing evolution sessions. */
    getRitualHandler() {
        if (!this._ritualHandler) {
            this._ritualHandler = new RitualHandler(this.db);
        }
        return this._ritualHandler;
    }
    escalateRisk(intent) {
        const nextRisk = {
            low: "medium",
            medium: "high",
            high: "high",
        };
        return {
            ...intent,
            riskLevel: nextRisk[intent.riskLevel] ?? "high",
        };
    }
}
// Re-export for convenience
export { EvolutionDB } from "./db.js";
export { TraceCollector } from "./trace/collector.js";
export { Mutator } from "./mutator/mutator.js";
export { Validator } from "./validator/validator.js";
export { Switcher } from "./switcher/switcher.js";
export { CircuitBreaker } from "./circuit-breaker/circuit-breaker.js";
export * from "./types.js";
