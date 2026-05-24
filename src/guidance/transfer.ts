// src/guidance/transfer.ts
import type { AgentRepository } from "../agents/repository.js"

export interface TransferRequest {
  fromAgentId: string
  message: string
  suggestedKeywords: string[]
}

export interface TransferResult {
  targetAgentId: string | null
  targetAgentName: string | null
  loop: boolean
  reason: string
}

/**
 * Handles agent-initiated transfer requests.
 * An agent can request routing of a message to a different agent.
 * Loop detection: if the suggested target is the same as the source, return loop=true.
 */
export class TransferHandler {
  constructor(private agentRepo: AgentRepository) {}

  async handle(req: TransferRequest): Promise<TransferResult> {
    const { fromAgentId, suggestedKeywords } = req

    // Find the best candidate among active agents based on keywords
    const activeAgents = this.agentRepo.listActiveMainAgents()

    let bestAgent = null
    let bestScore = 0

    for (const agent of activeAgents) {
      // Skip the originating agent itself for the loop check later
      const text = [agent.agent_name, agent.description ?? ""].join(" ").toLowerCase()
      let score = 0
      for (const kw of suggestedKeywords) {
        if (kw.length >= 2 && text.includes(kw.toLowerCase())) {
          score++
        }
      }
      if (score > bestScore) {
        bestScore = score
        bestAgent = agent
      }
    }

    // Loop detection
    if (bestAgent && bestAgent.id === fromAgentId) {
      return {
        targetAgentId: null,
        targetAgentName: null,
        loop: true,
        reason: `Transfer loop detected: agent "${bestAgent.agent_name}" routed back to itself`,
      }
    }

    if (!bestAgent || bestScore === 0) {
      return {
        targetAgentId: null,
        targetAgentName: null,
        loop: false,
        reason: "No suitable target agent found for transfer",
      }
    }

    return {
      targetAgentId: bestAgent.id,
      targetAgentName: bestAgent.agent_name,
      loop: false,
      reason: `Transferring to agent "${bestAgent.agent_name}" (score=${bestScore})`,
    }
  }
}
