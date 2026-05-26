// @ts-nocheck
import { randomUUID } from "crypto";
import { TraceAnalyzer } from "./trace-analyzer.js";
import { MemoryTopicsAnalyzer } from "./memory-topics-analyzer.js";
import { UpstreamSyncSource } from "./upstream-sync.js";
export class IntentEngine {
    db;
    traceAnalyzer;
    memoryAnalyzer;
    upstreamSource;
    constructor(config) {
        this.db = config.db;
        this.traceAnalyzer = new TraceAnalyzer(config.db);
        this.memoryAnalyzer = new MemoryTopicsAnalyzer(config.memoryDbPath);
        this.upstreamSource = new UpstreamSyncSource({
            db: config.db,
            providerRouter: config.providerRouter,
            repoRoot: config.repoRoot,
            upstreamRepos: config.upstreamRepos ?? [],
        });
    }
    /**
     * Run all three sources, deduplicate, sort by risk (low first), write to DB.
     * Returns the number of new intents inserted.
     */
    async generateIntents() {
        const candidates = [
            ...this.traceAnalyzer.analyze(),
            ...this.memoryAnalyzer.analyze(),
            ...(await this.upstreamSource.check()),
        ];
        const newIntents = candidates.filter(intent => !this.db.hasPendingIntentWithDescription(intent.description));
        const riskOrder = { low: 0, medium: 1, high: 2 };
        newIntents.sort((a, b) => riskOrder[a.riskLevel] - riskOrder[b.riskLevel]);
        for (const intent of newIntents) {
            this.db.insertIntent(intent);
        }
        return newIntents.length;
    }
    /**
     * Add a user-triggered intent. Always requires human approval.
     * Returns the new intent id.
     */
    addUserIntent(params) {
        const now = Date.now();
        const intent = {
            id: randomUUID(),
            type: "new_feature",
            description: params.description,
            targetFiles: params.targetFiles,
            evidence: params.evidence ?? ["User-requested"],
            riskLevel: params.riskLevel,
            status: "pending",
            createdAt: now,
            updatedAt: now,
        };
        this.db.insertIntent(intent);
        return intent.id;
    }
}
