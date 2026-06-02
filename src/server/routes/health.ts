import type { FastifyInstance } from "fastify"
import type { TwinSystemInstance } from "../../twin-system/factory.js"

interface HealthRouteOpts {
  twinSystem?: TwinSystemInstance
}

export async function healthRoute(
  fastify: FastifyInstance,
  opts?: HealthRouteOpts,
): Promise<void> {
  fastify.get("/v1/health", async (_request, reply) => {
    const base: Record<string, unknown> = {
      status: "ok",
      timestamp: new Date().toISOString(),
    }

    // Include twin-system observability if available
    if (opts?.twinSystem) {
      const ts = opts.twinSystem
      const metricsSnap = ts.metrics.snapshot()
      base.evolution = {
        enabled: true,
        dryRun: ts.dryRun,
        totalCycles: metricsSnap.totalCycles,
        successCount: metricsSnap.successCount,
        failureCount: metricsSnap.failureCount,
        rollbackCount: metricsSnap.rollbackCount,
        cyclesToday: metricsSnap.cyclesToday,
        dailyBudgetRemaining: metricsSnap.dailyBudgetRemaining,
        avgDurationMs: metricsSnap.avgDurationMs,
        lastCycleAt: metricsSnap.lastCycleAt,
        uptimeSeconds: metricsSnap.uptimeSeconds,
      }
    }

    return reply.send(base)
  })
}
