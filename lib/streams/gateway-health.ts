import type { AdminClient } from '@/lib/admin/types'
import type { GatewayHealth } from '@/lib/streams/gateway'
import { serverGatewayBase } from '@/lib/streams/wall'

// P2-4 brief item 3: the Monitoring page shows the video gateway's health. The web server reads the gateway's /g/health JSON (counts and
// ages only: no session id, person, camera or address) at the address browsers use (NEXT_PUBLIC_STREAM_GATEWAY_URL), or
// GATEWAY_HEALTH_URL when the server must reach it another way.

export type GatewayHealthView = { ok: true; health: GatewayHealth } | { ok: false }

const isCount = (n: unknown): n is number => typeof n === 'number' && Number.isInteger(n) && n >= 0

function parse(o: unknown): GatewayHealth | null {
  if (typeof o !== 'object' || o === null) return null
  const h = o as Record<string, unknown>
  if ((h.status !== 'ok' && h.status !== 'not_verifying') || (h.registry !== 'ok' && h.registry !== 'failing')) return null
  if (!isCount(h.openSessions) || !isCount(h.validateEverySec) || !isCount(h.failClosedAfterSec)) return null
  if (h.lastValidationAgeSec !== null && !isCount(h.lastValidationAgeSec)) return null
  return {
    status: h.status, registry: h.registry, openSessions: h.openSessions, lastValidationAgeSec: h.lastValidationAgeSec as number | null,
    validateEverySec: h.validateEverySec, failClosedAfterSec: h.failClosedAfterSec,
  }
}

/** The gateway's own health, or `{ ok: false }` when it is not configured, not answering (2 s) or answers something else. */
export async function readGatewayHealth(
  // P3-1: with a derived browser address (unset, `auto` or a path) the server asks the gateway on this computer (serverGatewayBase).
  base: string | null = serverGatewayBase(),
  fetchImpl: typeof fetch = fetch,
  timeoutMs = 2000,
): Promise<GatewayHealthView> {
  if (!base) return { ok: false }
  try {
    const res = await fetchImpl(`${base}/g/health`, { signal: AbortSignal.timeout(timeoutMs), redirect: 'manual', cache: 'no-store' })
    if (!res.ok) return { ok: false }
    const health = parse(await res.json())
    return health ? { ok: true, health } : { ok: false }
  } catch {
    return { ok: false }
  }
}

/** Video sessions of the organisation that are open right now (connected, not closed, not revoked, not expired); null when unreadable. */
export async function openVideoSessions(admin: AdminClient, orgId: string): Promise<number | null> {
  const { count, error } = await admin.from('media_sessions').select('id', { count: 'exact', head: true })
    .eq('org_id', orgId).not('opened_at', 'is', null).is('closed_at', null).is('revoked_at', null).gt('expires_at', new Date().toISOString())
  return error ? null : (count ?? 0)
}
