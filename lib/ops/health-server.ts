import { statfs } from 'node:fs/promises'
import { getWorkerStatus } from '@/lib/monitor/health'
import { logger } from '@/lib/observability/logger'
import { collectHealth, expectedMigration, type DetailedHealth, type DiskInfo, type OpsDbStatus } from '@/lib/ops/health'
import { readGatewayHealth } from '@/lib/streams/gateway-health'
import { createAdminClient } from '@/lib/supabase/admin'

// P5.4: the real inputs of lib/ops/health.ts on the web server. The database part goes through the web app's own role (app_web:
// ops_health_status, worker_state, worker_leases); the gateway through its /g/health (lib/streams/gateway-health.ts); the disk is the
// one holding DRISHTI_DATA_DIR (backups and logs, deploy/windows) or, without it, the server's own folder.

export async function diskInfo(dir: string): Promise<DiskInfo | null> {
  try {
    const s = await statfs(dir)
    return { path: dir, freeBytes: Number(s.bavail) * Number(s.bsize), totalBytes: Number(s.blocks) * Number(s.bsize) }
  } catch {
    return null
  }
}

export function readDetailedHealth(env: Record<string, string | undefined> = process.env): Promise<DetailedHealth> {
  const admin = createAdminClient()
  return collectHealth({
    build: env.NEXT_PUBLIC_BUILD_ID || 'dev',
    now: () => new Date(),
    opsStatus: async () => {
      const { data, error } = await admin.rpc('ops_health_status')
      if (error || !data || typeof data !== 'object') throw new Error('ops_health_status could not be read')
      return data as unknown as OpsDbStatus
    },
    workerStatus: () => getWorkerStatus(admin),
    gateway: () => readGatewayHealth(),
    disk: () => diskInfo(env.DRISHTI_DATA_DIR?.trim() || process.cwd()),
    expectedMigration: () => expectedMigration(process.cwd(), env),
  })
}

/** A lasting problem would otherwise be logged on every request; once a minute is enough. Only the names of the failed checks. */
const DEGRADED_LOG_EVERY_MS = 60_000
let lastDegradedLog = Number.NEGATIVE_INFINITY
export function logIfDegraded(h: DetailedHealth, nowMs: number = Date.now()): void {
  if (h.status === 'ok' || nowMs - lastDegradedLog < DEGRADED_LOG_EVERY_MS) return
  lastDegradedLog = nowMs
  logger.warn({ event: 'health_degraded', failed: h.checks.filter((c) => c.state === 'failed').map((c) => c.key) })
}
