/**
 * ApprovalGate — Manages human approval workflow for evolution intents.
 *
 * Flow:
 * 1. Pipeline calls `requestApproval(intent, summary)`
 * 2. ApprovalGate checks auto-approval rules:
 *    - If risk level is in `autoApproveRiskLevels` → auto-approve
 *    - Otherwise → queue and wait for human decision
 * 3. Human approves/rejects via API or request times out
 *
 * Design:
 * - Pending requests stored in-memory (lost on restart — acceptable for v1)
 * - Each request has a configurable timeout (default: 1 hour)
 * - Timeout behavior: reject (safe default)
 */

import type { EvolutionIntent, RiskLevel } from "./types.js"

// ── Types ────────────────────────────────────────────────────────────────────

export interface ApprovalRequest {
  id: string
  intentId: string
  intentDescription: string
  intentType: string
  riskLevel: RiskLevel
  summary: string
  createdAt: number
  expiresAt: number
  status: "pending" | "approved" | "rejected" | "expired"
  decidedAt?: number
  decidedBy?: string
}

export interface ApprovalGateConfig {
  /** Risk levels that are automatically approved without human review */
  autoApproveRiskLevels: RiskLevel[]
  /** Timeout for pending approvals (ms). After this, request is auto-rejected. */
  approvalTimeoutMs: number
  /** Max pending requests in queue */
  maxPendingRequests: number
}

export const DEFAULT_APPROVAL_CONFIG: ApprovalGateConfig = {
  autoApproveRiskLevels: ["low"],
  approvalTimeoutMs: 60 * 60 * 1000, // 1 hour
  maxPendingRequests: 10,
}

export interface ApprovalGateLogger {
  info(msg: string, ...args: unknown[]): void
  warn(msg: string, ...args: unknown[]): void
}

// ── Implementation ───────────────────────────────────────────────────────────

export class ApprovalGate {
  private config: ApprovalGateConfig
  private pending: Map<string, ApprovalRequest> = new Map()
  private resolvers: Map<string, (approved: boolean) => void> = new Map()
  private logger: ApprovalGateLogger
  private requestCounter = 0

  constructor(config?: Partial<ApprovalGateConfig>, logger?: ApprovalGateLogger) {
    this.config = { ...DEFAULT_APPROVAL_CONFIG, ...config }
    this.logger = logger ?? { info: () => {}, warn: () => {} }
  }

  /**
   * Request approval for an intent. Returns a Promise that resolves to
   * true (approved) or false (rejected/expired).
   *
   * If the intent's risk level is in autoApproveRiskLevels, resolves immediately.
   */
  async requestApproval(intent: EvolutionIntent, summary: string): Promise<boolean> {
    // Auto-approve check
    if (this.config.autoApproveRiskLevels.includes(intent.riskLevel)) {
      this.logger.info(
        "Auto-approving intent %s (riskLevel=%s in autoApproveRiskLevels)",
        intent.id,
        intent.riskLevel,
      )
      return true
    }

    // Queue limit check
    if (this.pending.size >= this.config.maxPendingRequests) {
      this.logger.warn(
        "Approval queue full (%d/%d), rejecting intent %s",
        this.pending.size,
        this.config.maxPendingRequests,
        intent.id,
      )
      return false
    }

    // Create pending request
    const requestId = this.generateId()
    const now = Date.now()
    const request: ApprovalRequest = {
      id: requestId,
      intentId: intent.id,
      intentDescription: intent.description,
      intentType: intent.type,
      riskLevel: intent.riskLevel,
      summary,
      createdAt: now,
      expiresAt: now + this.config.approvalTimeoutMs,
      status: "pending",
    }

    this.pending.set(requestId, request)
    this.logger.info(
      "Approval requested for intent %s (requestId=%s, riskLevel=%s, timeout=%dms)",
      intent.id,
      requestId,
      intent.riskLevel,
      this.config.approvalTimeoutMs,
    )

    // Create a promise that resolves when approved/rejected/expired
    return new Promise<boolean>((resolve) => {
      this.resolvers.set(requestId, resolve)

      // Set timeout
      setTimeout(() => {
        if (this.pending.has(requestId) && request.status === "pending") {
          request.status = "expired"
          request.decidedAt = Date.now()
          this.pending.delete(requestId)
          this.resolvers.delete(requestId)
          this.logger.warn("Approval request %s expired for intent %s", requestId, intent.id)
          resolve(false)
        }
      }, this.config.approvalTimeoutMs)
    })
  }

  /**
   * Approve a pending request by ID.
   * Returns true if the request was found and approved.
   */
  approve(requestId: string, decidedBy?: string): boolean {
    const request = this.pending.get(requestId)
    if (!request || request.status !== "pending") return false

    request.status = "approved"
    request.decidedAt = Date.now()
    request.decidedBy = decidedBy
    this.pending.delete(requestId)

    const resolver = this.resolvers.get(requestId)
    if (resolver) {
      resolver(true)
      this.resolvers.delete(requestId)
    }

    this.logger.info("Approval granted for request %s (intent=%s)", requestId, request.intentId)
    return true
  }

  /**
   * Reject a pending request by ID.
   * Returns true if the request was found and rejected.
   */
  reject(requestId: string, decidedBy?: string): boolean {
    const request = this.pending.get(requestId)
    if (!request || request.status !== "pending") return false

    request.status = "rejected"
    request.decidedAt = Date.now()
    request.decidedBy = decidedBy
    this.pending.delete(requestId)

    const resolver = this.resolvers.get(requestId)
    if (resolver) {
      resolver(false)
      this.resolvers.delete(requestId)
    }

    this.logger.info("Approval denied for request %s (intent=%s)", requestId, request.intentId)
    return true
  }

  /**
   * List all pending approval requests.
   */
  listPending(): ApprovalRequest[] {
    // Expire stale requests first
    this.expireStale()
    return [...this.pending.values()].filter((r) => r.status === "pending")
  }

  /**
   * Get a specific request by ID (even if no longer pending).
   */
  getRequest(requestId: string): ApprovalRequest | undefined {
    return this.pending.get(requestId)
  }

  /**
   * Get count of pending requests.
   */
  get pendingCount(): number {
    this.expireStale()
    return this.pending.size
  }

  // ── Private ──────────────────────────────────────────────────────────────

  private generateId(): string {
    return `apr_${Date.now().toString(36)}_${(++this.requestCounter).toString(36)}`
  }

  private expireStale(): void {
    const now = Date.now()
    for (const [id, request] of this.pending) {
      if (request.status === "pending" && now >= request.expiresAt) {
        request.status = "expired"
        request.decidedAt = now
        this.pending.delete(id)
        const resolver = this.resolvers.get(id)
        if (resolver) {
          resolver(false)
          this.resolvers.delete(id)
        }
      }
    }
  }
}
