import { cachedFor } from '@/lib/monitor/health'
import { publicStatus, type DetailedHealth } from '@/lib/ops/health'
import { logIfDegraded, readDetailedHealth } from '@/lib/ops/health-server'

export const dynamic = 'force-dynamic'

const UNREADABLE: DetailedHealth = { status: 'degraded', build: 'unknown', checkedAt: '', checks: [] }

// The answer is kept for 2 seconds, so that anyone hammering this public address cannot make the database work harder than that.
const read = cachedFor(2000, async () => {
  const h = await readDetailedHealth().catch(() => UNREADABLE)
  logIfDegraded(h)
  return publicStatus(h)
})

// Public (P5.4 brief item 3, the minimal variant): "ok" or "degraded", worked out from every check of the detailed health. No counts,
// names, addresses, versions or error details; those are on the Health page and /api/health/detail, for super administrators only.
export async function GET() {
  return Response.json(await read(), { headers: { 'Cache-Control': 'no-store' } })
}
