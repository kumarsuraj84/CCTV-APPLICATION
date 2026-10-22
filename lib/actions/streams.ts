'use server'

import { auditAccess } from '@/lib/auth/access-audit'
import { holds } from '@/lib/auth/capabilities'
import { requireProfile } from '@/lib/auth/profile'
import { MSG_ACCESS_CHECK_FAILED } from '@/lib/auth/resource'
import { logger } from '@/lib/observability/logger'
import { Go2rtcClient } from '@/lib/streams/go2rtc'
import { MSG_UNAVAILABLE, openStreams, renewStreams, type OpenedStream, type RenewedToken } from '@/lib/streams/open'
import { liveRequestLimiter, MSG_TOO_MANY_REQUESTS } from '@/lib/streams/request-limit'
import { createAdminClient } from '@/lib/supabase/admin'
import { createClient } from '@/lib/supabase/server'

export type OpenStreamsState = { ok: true; streams: OpenedStream[] } | { ok: false; error: string }

// Live video needs cctv.live (P2-2). The count is the live one (30 a minute per person, its own: lib/streams/request-limit.ts).
const limiter = liveRequestLimiter
const TOO_MANY = MSG_TOO_MANY_REQUESTS

async function run(cameraIds: string[], kind: 'sub' | 'main', route: 'openStreamsAction' | 'refreshStreamTokensAction'): Promise<OpenStreamsState> {
  const p = await requireProfile() // sends signed-out people to the sign-in page
  // A summary that could not be read is the plain access-check failure (fix M-4). Without cctv.live anywhere the answer is the one for
  // cameras the person may not watch: nothing, without a word, and nothing asked.
  if (p.capabilities.failed) return { ok: false, error: MSG_ACCESS_CHECK_FAILED }
  if (!holds(p.capabilities, 'cctv.live')) return { ok: true, streams: [] }
  if (!limiter.allow(p.id)) return { ok: false, error: TOO_MANY }
  try {
    const go2rtc = new Go2rtcClient(process.env.GO2RTC_URL ?? 'http://127.0.0.1:1984')
    const admin = createAdminClient()
    // openStreams asks the database, as the person, which of these cameras they may watch live (cameras_with_capability('cctv.live')).
    const res = await openStreams({ admin, rls: await createClient(), go2rtc }, { id: p.id, orgId: p.org_id }, Array.isArray(cameraIds) ? cameraIds : [], kind)
    if (!res.ok) return { ok: false, error: res.error }
    // An opening is recorded; the wall's renewals (P2-4: every minute, a full one every 8 minutes) are not (they open nothing new).
    if (route === 'openStreamsAction' && res.streams.length > 0) {
      await auditAccess(admin, { orgId: p.org_id, actorId: p.id, action: 'cctv_live_opened', capability: 'cctv.live', cameraIds: res.streams.map((s) => s.cameraId), detail: { kind } })
    }
    return { ok: true, streams: res.streams }
  } catch (error) {
    // The kind of error only, never its message: it can carry an address or a camera password.
    logger.error({ event: 'open_streams_action_failed', route, errorName: error instanceof Error ? error.name : typeof error })
    return { ok: false, error: MSG_UNAVAILABLE }
  }
}

/** Opens the cameras the caller may watch live (up to 36) and returns a signed token for each; the rest are left out without a word. */
export async function openStreamsAction(cameraIds: string[], kind: 'sub' | 'main'): Promise<OpenStreamsState> {
  return run(cameraIds, kind, 'openStreamsAction')
}

/**
 * The same call without the audit record: the wall's full renewal (every 8 minutes) and its retries for cameras that failed. Tokens
 * connect within 90 seconds (P2-4); cctv.live is checked again each time.
 */
export async function refreshStreamTokensAction(cameraIds: string[], kind: 'sub' | 'main'): Promise<OpenStreamsState> {
  return run(cameraIds, kind, 'refreshStreamTokensAction')
}

export type RenewTokensState = { ok: true; tokens: RenewedToken[] } | { ok: false; error: string }

/**
 * P2-4 review m-11: the wall's one-minute renewal — new tokens (and media sessions) for cameras already open, after checking cctv.live
 * again; no NVR login and no go2rtc request. Counted with the live requests like the other two.
 */
export async function renewStreamTokensAction(cameraIds: string[], kind: 'sub' | 'main'): Promise<RenewTokensState> {
  const p = await requireProfile()
  if (p.capabilities.failed) return { ok: false, error: MSG_ACCESS_CHECK_FAILED }
  if (!holds(p.capabilities, 'cctv.live')) return { ok: true, tokens: [] }
  if (!limiter.allow(p.id)) return { ok: false, error: TOO_MANY }
  try {
    const res = await renewStreams({ admin: createAdminClient(), rls: await createClient() }, { id: p.id, orgId: p.org_id }, Array.isArray(cameraIds) ? cameraIds : [], kind)
    return res.ok ? { ok: true, tokens: res.tokens } : { ok: false, error: res.error }
  } catch (error) {
    logger.error({ event: 'open_streams_action_failed', route: 'renewStreamTokensAction', errorName: error instanceof Error ? error.name : typeof error })
    return { ok: false, error: MSG_UNAVAILABLE }
  }
}
