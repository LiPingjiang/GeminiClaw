// @ts-nocheck
// src/server/routes/evolution-deps.ts
// 提供全局访问 EvolutionEngine 的方式
let globalEvolutionEngine = null;
export function setEvolutionEngine(engine) {
    globalEvolutionEngine = engine;
}
export function getEvolutionEngine() {
    return globalEvolutionEngine;
}
