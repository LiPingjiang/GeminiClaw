// src/server/routes/evolution-deps.ts
// 提供全局访问 EvolutionEngine 的方式

import type { EvolutionEngine } from "../../evolution/index.js"

let globalEvolutionEngine: EvolutionEngine | null = null

export function setEvolutionEngine(engine: EvolutionEngine): void {
  globalEvolutionEngine = engine
}

export function getEvolutionEngine(): EvolutionEngine | null {
  return globalEvolutionEngine
}