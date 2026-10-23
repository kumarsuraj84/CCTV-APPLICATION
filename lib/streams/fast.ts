import type { Actor, Result } from '@/lib/admin/types'
import { auditAccess } from '@/lib/auth/access-audit'
import { MSG_ACCESS_CHECK_FAILED } from '@/lib/auth/resource'
import { MAX_DOWNLOAD_BYTES, MAX_DOWNLOAD_MS } from '@/lib/nvr/client'
import { logger } from '@/lib/observability/logger'
import { getSecret } from '@/lib/secrets'
import { FAST_TOKEN_LIFETIME_SEC, fastStreamName, signFastToken, verifyFastToken } from '@/lib/streams/fast-token'
import { framingKey, xorFrame } from '@/lib/streams/framing'
import { paceFragmentedMp4 } from '@/lib/streams/pace'
import { findCamera, MSG_BAD_START, MSG_CAMERA_NOT_FOUND, startInBounds, type LookupDeps } from '@/lib/streams/playback'
import { adminRegistry, type RegistryClient } from '@/lib/streams/registry'
import { remuxFromEnv } from '@/lib/streams/remux'
import { MSG_TOO_MANY_REQUESTS } from '@/lib/streams/request-limit'
import {
  FAST_BURST_SEC, FAST_FRAMING, FAST_FRAMING_HEADER, FAST_MAX_BYTES_PER_REC_SEC, FAST_STREAM_CONTENT_TYPE, fastBudget, isFastSpeed, MAX_FAST_MINUTES, MSG_FAST_BUDGET,
  MSG_FAST_NOT_SET_UP, VIEWER_IDLE_MS,
} from '@/lib/streams/speed'
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

// Review round 1 (owner ruling on I-1: playback-only people must not be able to dump recordings): the speed is SIGNED in the token and
// the stream layer releases the recording no faster than that (lib/streams/pace.ts; ffmpeg also reads with -readrate), with a byte cap
// per stream, a per-person budget of recording minutes kept in the database (media_session_create_fast: 120 per hour and 8 hours per day
// by default), one fast playback per person at a time (a new one supersedes the running one), a token that plays once
// (media_session_finish), and a body framed so that saved bytes are not a playable file (lib/streams/framing.ts — obfuscation only).
// What dumping an hour of recording now costs: at least 3.75 minutes of wall time at 16x for each hour (30 minutes at 2x), at most 2
// hours of recording per hour and 8 hours per day per person, every playback audited with the person, camera and minutes.

export { MSG_FAST_NOT_SET_UP }
export const MSG_BAD_SPEED = 'Choose a speed of 2x, 4x, 8x or 16x.'
const MSG_BAD_LENGTH = `Choose how long to play, from 1 to ${MAX_FAST_MINUTES} minutes.`

export type FastDeps = LookupDeps & Pick<VodDeps, 'remux' | 'conversions' | 'env' | 'offsetMin' | 'timing'> & {
  registry?: RegistryClient
  /** Milliseconds since the epoch (default Date.now): token expiry and the start bounds. */
  now?: () => number
  /** The token key (default: the stream_token secret). */
  secret?: string | null
  /** The budget of recording minutes per person (default: FAST_PLAYBACK_MINUTES_PER_HOUR / _PER_DAY, else 120 / 480). */
  budget?: { perHourMin: number; perDayMin: number }
}
type Who = Pick<Actor, 'id' | 'orgId'>

/**
 * A fast playback token for `minutes` (1 to 30) of recording from a shown-time `start` (not more than 15 minutes ahead of the shown
 * clock, not older than a year) at `speed` (2x to 16x, signed: the stream is paced to it), within the person's budget.
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
  // Review I-1: the budget, one-at-a-time and the session in ONE database call under a per-person lock (every tab, every app instance).
  const budget = deps.budget ?? fastBudget(env)
  let row: { sid: string | null; refused: string | null } | undefined
  try {
    const { data, error } = await deps.admin.rpc('media_session_create_fast', {
      p_org: actor.orgId, p_user: actor.id, p_camera: camera, p_stream: fastStreamName({ c: camera, s, e }),
      p_hour_min: budget.perHourMin, p_day_min: budget.perDayMin, p_max_sec: Math.ceil(MAX_DOWNLOAD_MS / 1000) + 60,
    })
    if (error) throw new Error(error.code ?? 'error')
    row = (Array.isArray(data) ? data[0] : data) as typeof row
  } catch {
    logger.error({ event: 'fast_playback_session_failed' })
    return { ok: false, error: MSG_ACCESS_CHECK_FAILED }
  }
  if (row?.refused === 'budget_hour' || row?.refused === 'budget_day') {
    await auditAccess(deps.admin, { orgId: actor.orgId, actorId: actor.id, action: 'cctv_fast_playback_denied', capability: 'cctv.playback', cameraIds: [camera], detail: { reason: row.refused, minutes } })
    return { ok: false, error: MSG_FAST_BUDGET(budget) }
  }
  const sid = row?.sid
  if (!sid) return { ok: false, error: MSG_CAMERA_NOT_FOUND }
  return { ok: true, token: signFastToken({ sid, u: actor.id, c: camera, s, e, sp: speed, exp: Math.floor(now() / 1000) + FAST_TOKEN_LIFETIME_SEC }, secret), minutes }
}

/** Closes a fast session for good with the recording seconds it released (it then counts that against the budget and never reopens). */
async function finishSession(deps: FastDeps, sid: string, mediaSec: number): Promise<void> {
  try {
    const { error } = await deps.admin.rpc('media_session_finish', { p_sid: sid, p_media_sec: Math.max(0, Math.round(mediaSec)) })
    if (error) logger.error({ event: 'fast_playback_finish_failed', errorCode: error.code })
  } catch {
    logger.error({ event: 'fast_playback_finish_failed' })
  }
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
  const spanSec = claims.e - claims.s
  // Review I-1: bytes per stream in proportion to its span (16 Mbit/s of recording), never more than the generic transfer cap.
  const maxBytes = Math.min(MAX_DOWNLOAD_BYTES, spanSec * (deps.timing?.maxBytesPerSec ?? FAST_MAX_BYTES_PER_REC_SEC))
  const key = framingKey(token)
  let paced = false
  const res = await deliverRecording({
    deps: { ...deps, remux: deps.remux ?? remuxFromEnv(env), env },
    pool: 'fast',
    readrate: claims.sp,
    maxBytes,
    transform: (body) => {
      paced = true
      return paceFragmentedMp4(body, {
        speed: claims.sp,
        burstSec: deps.timing?.burstSec ?? FAST_BURST_SEC,
        maxBytes,
        viewerIdleMs: deps.timing?.viewerIdleMs ?? VIEWER_IDLE_MS,
        frame: (bytes, offset) => xorFrame(bytes, key, offset),
        onEnd: (end) => {
          if (end.reason !== 'complete') logger.warn({ event: 'fast_playback_stream_ended', reason: end.reason, mediaSec: end.mediaSec })
          void finishSession(deps, claims.sid, end.mediaSec)
        },
      })
    },
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
    headers: (family) => ({ 'Content-Type': FAST_STREAM_CONTENT_TYPE, 'Cache-Control': 'no-store, private', 'X-Video-Codec': family ?? 'unknown', [FAST_FRAMING_HEADER]: FAST_FRAMING }),
  })
  // Nothing was streamed (no recording there, NVR trouble, busy): the session is closed for good and charged nothing.
  if (!paced) void finishSession(deps, claims.sid, 0)
  return res
}
