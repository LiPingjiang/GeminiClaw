// src/agent/iteration-budget.ts
/**
 * Refundable iteration budget — inspired by Hermes's IterationBudget.
 *
 * Key insight: tools that MERGE multiple steps into one (like execute_script)
 * should not consume budget — they're already saving iterations. Refunding
 * them incentivizes the model to batch operations.
 *
 * Also provides a "grace call" mechanism: when budget is exhausted, allow
 * one final LLM call (without tools) to produce a graceful summary instead
 * of hard-cutting mid-task.
 */

export class IterationBudget {
  private _used = 0;
  private _graceUsed = false;
  private _refundCount = 0;

  constructor(
    private readonly cap: number,
    private readonly graceAllowed: boolean = true,
  ) {}

  /** How many iterations have been consumed. */
  get used(): number {
    return this._used;
  }

  /** How many iterations remain. */
  get remaining(): number {
    return Math.max(0, this.cap - this._used);
  }

  /** Whether the budget is fully consumed. */
  get exhausted(): boolean {
    return this._used >= this.cap;
  }

  /** Whether a grace call is still available. */
  get canGrace(): boolean {
    return this.graceAllowed && !this._graceUsed && this.exhausted;
  }

  /** Total refunds issued (for metrics). */
  get refundCount(): number {
    return this._refundCount;
  }

  /**
   * Consume one iteration. Returns true if budget was available.
   * Returns false if exhausted (caller should check canGrace).
   */
  consume(): boolean {
    if (this._used < this.cap) {
      this._used++;
      return true;
    }
    return false;
  }

  /**
   * Refund one iteration (used for batch tools like execute_script).
   * Cannot refund below 0.
   */
  refund(): void {
    if (this._used > 0) {
      this._used--;
      this._refundCount++;
    }
  }

  /**
   * Use the grace call (only once). Returns true if grace was available.
   */
  useGrace(): boolean {
    if (!this.canGrace) return false;
    this._graceUsed = true;
    return true;
  }

  /**
   * Summary for logging/metrics.
   */
  toJSON(): { used: number; cap: number; remaining: number; refunds: number; graceUsed: boolean } {
    return {
      used: this._used,
      cap: this.cap,
      remaining: this.remaining,
      refunds: this._refundCount,
      graceUsed: this._graceUsed,
    };
  }
}
