import type { AdminClient } from '@/lib/admin/types'
import { logger } from '@/lib/observability/logger'

// The media session registry (P2-4, decision D-3, directive AC-14): every video connection is a row of media_sessions in the database
// (supabase/migrations/20261021000029_p24_media_sessions.sql). The web app makes the rows when it signs stream tokens; the video
// gateway opens a session when its socket arrives and re-checks all of its open sessions in one call every 15 seconds; the fast-
// playback route re-checks its own. P2-6 (D-14): each with its own database role — the gateway as video_gateway (EXECUTE on
// media_session_open / media_sessions_still_valid / media_session_close only), the web app's video path as media_service, the
// administration screens' revocations as app_web.
//
// The key is only ever put into request headers: never into a URL, an error message, or a log line.

/** The kind of a session as the registry knows it. Live and playback go through the gateway; vod through the fast-playback route. */
export type SessionKind = 'live' | 'playback' | 'vod' | 'export_download'
export type OpenAnswer = { ok: true; kind: string; stream: string | null } | { ok: false; reason: string }

export type RegistryClient = {
  /** Opens the session of a verified token: it must be that person's, for that camera, kind and stream. Throws when it cannot be asked. */
  open(sid: string, expect: { user: string; camera: string; kind: SessionKind; stream: string | null }): Promise<OpenAnswer>
  /** The sessions that must end now, with the reason (an unknown id is `not_found`). Throws when the registry cannot be asked. */
  stillValid(sids: readonly string[]): Promise<Map<string, string>>
  /** Marks the session closed. Never throws (closing is best effort: an unclosed session simply expires). */
  close(sid: string): Promise<void>
}

/** How long one registry call may take before it counts as failed (D-3: 15 s poll + 5 s call = 20 s worst case). */
export const REGISTRY_TIMEOUT_MS = 5000
/** Sessions per still-valid call (the database accepts 5000; the gateway holds at most a few hundred). */
export const STILL_VALID_BATCH = 1000

type OpenRow = { ok: boolean; reason: string | null; kind: string | null; stream: string | null }
type InvalidRow = { sid: string; reason: string }

function openAnswer(rows: unknown): OpenAnswer {
  const r = (Array.isArray(rows) ? rows[0] : rows) as OpenRow | undefined
  if (!r || typeof r.ok !== 'boolean') throw new Error('The access registry gave an unexpected answer.')
  return r.ok ? { ok: true, kind: String(r.kind), stream: r.stream ?? null } : { ok: false, reason: String(r.reason ?? 'refused') }
}

function invalidRows(rows: unknown, into: Map<string, string>) {
  if (!Array.isArray(rows)) throw new Error('The access registry gave an unexpected answer.')
  for (const r of rows as InvalidRow[]) {
    if (typeof r?.sid !== 'string') throw new Error('The access registry gave an unexpected answer.')
    into.set(r.sid, String(r.reason ?? 'refused'))
  }
}

async function inBatches(sids: readonly string[], ask: (part: string[]) => Promise<unknown>): Promise<Map<string, string>> {
  const out = new Map<string, string>()
  const unique = [...new Set(sids)]
  for (let i = 0; i < unique.length; i += STILL_VALID_BATCH) invalidRows(await ask(unique.slice(i, i + STILL_VALID_BATCH)), out)
  return out
}

/**
 * The gateway's client: PostgREST RPC calls with the gateway's own key (SUPABASE_URL / NEXT_PUBLIC_SUPABASE_URL and
 * SUPABASE_VIDEO_GATEWAY_KEY from the environment, read by services/gateway/index.ts; P2-6). Plain fetch: the gateway needs nothing
 * else of supabase-js.
 */
export function createRestRegistry(o: { url: string; serviceKey: string; timeoutMs?: number; fetchImpl?: typeof fetch }): RegistryClient {
  let base: URL
  try {
    base = new URL(o.url)
  } catch {
    throw new Error('The database address for the access registry is not valid.')
  }
  if (base.protocol !== 'http:' && base.protocol !== 'https:') throw new Error('The database address for the access registry is not valid.')
  if (typeof o.serviceKey !== 'string' || o.serviceKey.trim() === '') throw new Error('The access registry needs the database service key.')
  const key = o.serviceKey
  const root = `${base.origin}${base.pathname.replace(/\/+$/, '')}/rest/v1/rpc/`
  const doFetch = o.fetchImpl ?? fetch
  const timeout = o.timeoutMs ?? REGISTRY_TIMEOUT_MS

  async function rpc(name: string, args: Record<string, unknown>): Promise<unknown> {
    let res: Response
    try {
      res = await doFetch(root + name, {
        method: 'POST',
        headers: { apikey: key, Authorization: `Bearer ${key}`, 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify(args),
        signal: AbortSignal.timeout(timeout),
        redirect: 'manual',
      })
    } catch (e) {
      // The kind only: the text of a network error can carry the address.
      throw new Error(`The access registry could not be reached (${e instanceof Error ? e.name : 'error'}).`)
    }
    if (!res.ok) {
      await res.body?.cancel().catch(() => {})
      throw new Error(`The access registry refused the request (HTTP ${res.status}).`)
    }
    try {
      return await res.json()
    } catch {
      throw new Error('The access registry gave an unexpected answer.')
    }
  }

  return {
    async open(sid, expect) {
      return openAnswer(await rpc('media_session_open', { p_sid: sid, p_user: expect.user, p_camera: expect.camera, p_kind: expect.kind, p_stream: expect.stream }))
    },
    async stillValid(sids) {
      return inBatches(sids, (part) => rpc('media_sessions_still_valid', { p_sids: part }))
    },
    async close(sid) {
      try {
        await rpc('media_session_close', { p_sid: sid })
      } catch {
        // best effort: an unclosed session expires by itself
      }
    },
  }
}

/** The same registry through the web app's service-role client (the fast-playback route). */
export function adminRegistry(admin: AdminClient, timeoutMs = REGISTRY_TIMEOUT_MS): RegistryClient {
  const call = async (name: 'media_session_open' | 'media_sessions_still_valid' | 'media_session_close', args: Record<string, unknown>) => {
    const { data, error } = await admin.rpc(name, args as never).abortSignal(AbortSignal.timeout(timeoutMs))
    if (error) throw new Error(`The access registry refused the request (${error.code ?? 'error'}).`)
    return data as unknown
  }
  return {
    async open(sid, expect) {
      return openAnswer(await call('media_session_open', { p_sid: sid, p_user: expect.user, p_camera: expect.camera, p_kind: expect.kind, p_stream: expect.stream }))
    },
    async stillValid(sids) {
      return inBatches(sids, (part) => call('media_sessions_still_valid', { p_sids: part }))
    },
    async close(sid) {
      try {
        await call('media_session_close', { p_sid: sid })
      } catch {
        // best effort
      }
    },
  }
}

// ── The web app's side ────────────────────────────────────────────────────────

/**
 * Makes one media session per camera (service role, org-scoped). The database checks the person's capability for each camera again
 * (as has_capability_for would for them) and leaves out any it would refuse. Returns camera id → session id; throws when it cannot ask.
 */
export async function createMediaSessions(
  admin: AdminClient,
  o: { orgId: string; userId: string; kind: SessionKind; cameras: { id: string; stream: string | null }[]; connectSec?: number; maxSec?: number; aal2?: boolean },
): Promise<Map<string, string>> {
  const out = new Map<string, string>()
  if (o.cameras.length === 0) return out
  const { data, error } = await admin.rpc('media_session_create', {
    p_org: o.orgId, p_user: o.userId, p_kind: o.kind, p_cameras: o.cameras.map((c) => c.id),
    p_streams: o.cameras.map((c) => c.stream) as string[],
    // P3-1: the session's verified level (my_session_status), so a capability that requires MFA counts for it while the switch is on.
    ...(o.aal2 ? { p_aal2: true } : {}),
    ...(o.connectSec ? { p_connect_sec: o.connectSec } : {}), ...(o.maxSec ? { p_max_sec: o.maxSec } : {}),
  })
  if (error) throw new Error(`Could not register the video sessions (${error.code ?? 'error'}).`)
  for (const r of (data ?? []) as { camera_id: string; sid: string }[]) out.set(r.camera_id, r.sid)
  return out
}

/**
 * P4-L1 review I-1: live sessions under the person's stream cap, decided by the database under one lock per person
 * (media_session_create_live, migration 20261021000040): streams the person already holds first, new ones while their distinct held
 * streams (open sockets and tokens that can still connect) stay within `max`; the rest come back as `paused`. `release`: stream names the
 * wall let go of (their unused tokens are revoked and stop counting). Throws when it cannot ask (the caller then opens nothing).
 */
export async function createLiveSessions(
  admin: AdminClient,
  o: { orgId: string; userId: string; cameras: { id: string; stream: string }[]; max: number; release?: string[] },
): Promise<{ sids: Map<string, string>; paused: string[] }> {
  const sids = new Map<string, string>()
  const paused: string[] = []
  if (o.cameras.length === 0) return { sids, paused }
  const { data, error } = await admin.rpc('media_session_create_live', {
    p_org: o.orgId, p_user: o.userId, p_cameras: o.cameras.map((c) => c.id), p_streams: o.cameras.map((c) => c.stream), p_max: o.max,
    ...(o.release && o.release.length > 0 ? { p_release: o.release } : {}),
  })
  if (error || !Array.isArray(data)) throw new Error(`Could not register the video sessions (${error?.code ?? 'error'}).`)
  for (const r of data as { camera_id: string; sid: string | null; paused: boolean }[]) {
    if (r.paused) paused.push(r.camera_id)
    else if (r.sid) sids.set(r.camera_id, r.sid)
  }
  return { sids, paused }
}

/** Ends every open video session of a person at once (deactivation, password reset, role change; D-3). Best effort: false on failure. */
export async function revokeMediaSessions(admin: AdminClient, orgId: string, userId: string, reason: string): Promise<boolean> {
  const { error } = await admin.rpc('media_sessions_revoke_user', { p_org: orgId, p_user: userId, p_reason: reason })
  if (error) logger.error({ event: 'media_sessions_revoke_failed', errorCode: error.code })
  return !error
}

/** Re-checks the open video sessions of these people and ends exactly those that lost access (grant changes). Best effort. */
export async function revalidateMediaSessions(admin: AdminClient, orgId: string, userIds: string[]): Promise<boolean> {
  if (userIds.length === 0) return true
  const { error } = await admin.rpc('media_sessions_revalidate', { p_org: orgId, p_users: userIds })
  if (error) logger.error({ event: 'media_sessions_revalidate_failed', errorCode: error.code })
  return !error
}
