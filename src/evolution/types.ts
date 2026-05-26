// @ts-nocheck
// src/evolution/types.ts
// Shared types for the Evolution Engine (Phase A)
export const DEFAULT_EVOLUTION_CONFIG = {
    enabled: true,
    dataDir: ".gemini-data",
    validator: {
        level: 1,
        standbyPort: 18889,
        testPort: 19889,
        diffThreshold: 0.3,
    },
    mutator: {
        maxRounds: 3,
        confidenceThreshold: 0.7,
    },
    circuitBreaker: {
        errorRateThreshold: 0.2,
        responseTimeMultiplier: 2.0,
        maxEvolutionsPerFile24h: 3,
        failureThreshold: 0.5,
        monitoringWindowMs: 10 * 60 * 1000, // 10 minutes
        checkIntervalMs: 30 * 1000, // 30 seconds
    },
    background: {
        idleThresholdMs: 5 * 60 * 1000, // 5 minutes idle before auto-run
        cooldownMs: 60 * 60 * 1000, // 1 hour between runs
        tickIntervalMs: 60 * 1000, // check every 60s
    },
};
// ---------------------------------------------------------------------------
// Ritual Session State
// ---------------------------------------------------------------------------
