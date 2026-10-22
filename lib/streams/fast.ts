import type { Actor, Result } from '@/lib/admin/types'
import { auditAccess } from '@/lib/auth/access-audit'
import { MSG_ACCESS_CHECK_FAILED } from '@/lib/auth/resource'
import { MAX_DOWNLOAD_MS } from '@/lib/nvr/client'
import { logger } from '@/lib/observability/logger'
import { getSecret } from '@/lib/secrets'
import { FAST_TOKEN_LIFETIME_SEC, fastStreamName, signFastToken, verifyFastToken } from '@/lib/streams/fast-token'
import { findCamera, MSG_BAD_START, MSG_CAMERA_NOT_FOUND, startInBounds, type LookupDeps } from '@/lib/streams/playback'
import { adminRegistry, createMediaSessions, type RegistryClient } from '@/lib/streams/registry'
import { remuxFromEnv } from '@/lib/streams/remux'
import { MSG_TOO_MANY_REQUESTS } from '@/lib/streams/request-limit'
import { FAST_STREAM_CONTENT_TYPE, isFastSpeed, MAX_FAST_MINUTES } from '@/lib/streams/speed'
import { cameraFailure, deliverRecording, VOD_HEADERS, type VodDeps } from '@/lib/streams/vod'

// P4-L2 — fast playback 2x-16x as a browser stream (decision D-L1; brief items 3, 4, 6).
//
//   1. The Playback screen asks openFastPlaybackAction → openFastPlayback: cctv.playback for the camera (the database, as the person),
//      the remux adapter can work here, then ONE media session of kind playback (stream `fpb_<camera>_<start>_<end>`, made by
//      media_session_create, which checks the capability once more) and a fast token naming it (90 s connect window). Nothing is asked of
//      the NVR and no NVR login is read.
//   2. The screen fetches GET /api/playback/stream with the token in the x-playback-token header (the route refuses navigations, links,
//      <video src>, frames and a token in the address). serveFastStream: the token is genuine, unexpired and was made for THIS signed-in
//      person; cctv.playback for its camera again; the registry opens its session (its person, camera, kind and stream; one socket at a
//      time; refused once revoked) — only then the NVR login is read and the shared core (lib/streams/vod.ts deliverRecording) streams the
//      fragmented MP4 while the session is re-checked every 15 s (revoked or unverifiable for 45 s: the NVR transfer and the remux stop).
//   3. The answer is `application/vnd.ckdrishti.stream` with no Content-Disposition and no-store: not a file to save. The browser plays it
//      through Media Source Extensions (lib/streams/fast-client.ts).
//
// What it cannot prevent: a person can always film their screen, and developer tools can copy any bytes a page receives. There is no
// endpoint that hands out a recording file to a playback-only person, which is what D-L1 asks.

export const MSG_FAST_NOT_SET_UP = 'Fast playback is not set up on this server.'
export const MSG_BAD_SPEED = 'Choose a speed of 2x, 4x, 8x or 16x.'
const MSG_BAD_LENGTH = `Choose how long to play, from 1 to ${MAX_FAST_MINUTES} minutes.`

export type FastDeps = LookupDeps & Pick<VodDeps, 'remux' | 'conversions' | 'env' | 'offsetMin' | 'timing'> & {
  registry?: RegistryClient
  /** Milliseconds since the epoch (default Date.now): token expiry and the start bounds. */
  now?: () => number
  /** The token key (default: the stream_token secret). */
  secret?: string | null
}
type Who = Pick<Actor, 'id' | 'orgId'>

/**
 * A fast playback token for `minutes` (1 to 30) of recording from a shown-time `start` (not more than 15 minutes ahead of the shown
 * clock, not older than a year) at `speed` (2x to 16x; the speed itself is the browser's: it is checked and recorded, not signed).
 */
export async function openFastPlayback(deps: FastDeps, actor: Who, cameraId: string, start: Date, minutes: number, speed: number): Promise<Result<{ token: string; minutes: number }>> {
  const secret = deps.secret === undefined ? getSecret('stream_token') : deps.secret
  if (!secret) return { ok: false, error: MSG_FAST_NOT_SET_UP }
  if (!isFastSpeed(speed)) return { ok: false, error: MSG_BAD_SPEED }
  if (!Number.isInteger(minutes) || minutes < 1 || minutes > MAX_FAST_MINUTES) return { ok: false, error: MSG_BAD_LENGTH }
  const now = deps.now ?? Date.now
  if (!(start instanceof Date) || !Number.isFinite(start.getTime()) || !startInBounds(start.getTime(), now())) return { ok: false, error: MSG_BAD_START }
  if (deps.limiter && !(await deps.limiter.allow(actor.id))) return { ok: false, error: MSG_TOO_MANY_REQUESTS }

  const c = await findCamera(deps, cameraId, { password: 'later', capability: 'cctv.playback', orgId: actor.orgId, actorId: actor.id })
  if (!c.ok) return c
  const env = deps.env ?? process.env
  const remux = deps.remux ?? remuxFromEnv(env)
  if (!(await remux.check(env, { recorderHost: c.recorder.host })).ok) return { ok: false, error: MSG_FAST_NOT_SET_UP }

  const s = Math.floor(start.getTime() / 1000)
  const e = s + minutes * 60
  const camera = c.camera.id
  let sid: string | undefined
  try {
    sid = (await createMediaSessions(deps.admin, { orgId: actor.orgId, userId: actor.id, kind: 'playback', cameras: [{ id: camera, stream: fastStreamName({ c: camera, s, e }) }], maxSec: Math.ceil(MAX_DOWNLOAD_MS / 1000) + 60 })).get(camera)
  } catch {
    logger.error({ event: 'fast_playback_session_failed' })
    return { ok: false, error: MSG_ACCESS_CHECK_FAILED }
  }
  if (!sid) return { ok: false, error: MSG_CAMERA_NOT_FOUND }
  return { ok: true, token: signFastToken({ sid, u: actor.id, c: camera, s, e, exp: Math.floor(now() / 1000) + FAST_TOKEN_LIFETIME_SEC }, secret), minutes }
}

const notFound = () => Response.json({ error: MSG_CAMERA_NOT_FOUND }, { status: 404, headers: VOD_HEADERS })

/** The answer to GET /api/playback/stream for a signed-in person with cctv.playback somewhere (the route checked that), see the top. */
export async function serveFastStream(deps: FastDeps, actor: Who, token: string, signal?: AbortSignal): Promise<Response> {
  const now = deps.now ?? Date.now
  const denied = (reason: string, cameraIds?: string[]) =>
    auditAccess(deps.admin, { orgId: actor.orgId, actorId: actor.id, action: 'cctv_fast_playback_denied', capability: 'cctv.playback', ...(cameraIds ? { cameraIds } : {}), detail: { reason } })

  // A token that is not genuine, has expired, or was made for somebody else is the same "not found" as a camera that does not exist,
  // and the session it names is left untouched (its owner can still use it).
  const claims = typeof token === 'string' ? verifyFastToken(token, now(), deps.secret) : null
  if (!claims || claims.u !== actor.id) {
    await denied(claims ? 'token_person' : 'token')
    return notFound()
  }
  const c = await findCamera(deps, claims.c, { password: 'later', capability: 'cctv.playback', orgId: actor.orgId })
  if (!c.ok) {
    if (c.error === MSG_CAMERA_NOT_FOUND) await denied('camera', [claims.c])
    return cameraFailure(c.error)
  }
  if (signal?.aborted) return new Response(null, { status: 499 })

  const registry = deps.registry ?? adminRegistry(deps.admin)
  try {
    const opened = await registry.open(claims.sid, { user: actor.id, camera: claims.c, kind: 'playback', stream: fastStreamName(claims) })
    // Refused (revoked, already open, its window passed, access gone): never closed here — a copy must not end the running stream.
    if (!opened.ok) {
      await denied('session', [claims.c])
      return notFound()
    }
  } catch {
    logger.error({ event: 'fast_playback_open_failed', location: c.camera.code })
    return Response.json({ error: MSG_ACCESS_CHECK_FAILED }, { status: 503, headers: VOD_HEADERS })
  }

  const env = deps.env ?? process.env
  const played = { orgId: actor.orgId, actorId: actor.id, capability: 'cctv.playback' as const, cameraIds: [claims.c] }
  const minutes = (claims.e - claims.s) / 60
  return deliverRecording({
    deps: { ...deps, remux: deps.remux ?? remuxFromEnv(env), env },
    actorId: actor.id,
    route: c,
    startMs: claims.s * 1000,
    minutes,
    probe: false,
    signal,
    sid: claims.sid,
    registry,
    loginPurpose: 'playback',
    audit: {
      start: () => auditAccess(deps.admin, { ...played, action: 'cctv_fast_playback_started', detail: { minutes } }),
      end: () => auditAccess(deps.admin, { ...played, action: 'cctv_fast_playback_ended' }),
    },
    headers: (family) => ({ 'Content-Type': FAST_STREAM_CONTENT_TYPE, 'Cache-Control': 'no-store, private', 'X-Video-Codec': family ?? 'unknown' }),
  })
}
