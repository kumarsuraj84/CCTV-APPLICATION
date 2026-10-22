import type { Actor, AdminClient, Result } from '@/lib/admin/types'
import { IT_VIEW } from '@/lib/auth/capabilities'
import { cameraFor, MSG_ACCESS_CHECK_FAILED, recorderFor } from '@/lib/auth/resource'
import { MSG_MONITORING_OFF, MSG_NOT_MAPPED, readRecorderPassword, resolveCameraRoutes, type CameraRoute, type Recorder, type RouteAnswer } from '@/lib/inventory/recorders'
import { describeNvrError, NvrClient, NvrError, type NvrEndpoint } from '@/lib/nvr/client'
import { findSegments, recordedDays, type ClockOffset } from '@/lib/nvr/playback'
import { logger } from '@/lib/observability/logger'
import { getSecret } from '@/lib/secrets'
import type { Go2rtcClient } from '@/lib/streams/go2rtc'
import { MSG_NOT_SET_UP, MSG_UNAVAILABLE } from '@/lib/streams/open'
import { createMediaSessions } from '@/lib/streams/registry'
import { MSG_TOO_MANY_REQUESTS, type RequestLimiter } from '@/lib/streams/request-limit'
import { buildPlaybackUrl, demoSource, isDemoRecorder } from '@/lib/streams/source'
import { parseDay, shownNowMs } from '@/lib/streams/timeline'
import { signStreamToken, streamName, TOKEN_LIFETIME_SEC } from '@/lib/streams/token'

// Playback by day and time. Which cameras may be looked at is decided by the person's own client (cctv.playback, checked by the database
// as the person); the NVR address, login and password are read with the service role only for a camera that passed that check, are
// used for this one call and go nowhere else.
//
// TIMES (ruling R13). Every time that comes back from here, and the start that goes in, is a "shown time": a plain instant whose UTC clock
// fields are the wall clock people see (India time). It is NVR time + `offsetMin`, so it is NOT the real UTC instant unless the offset is 0
// and the machine clock were also on that clock. The NVR is asked for shown time - offsetMin. Nothing converts between time zones.

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const MAX_OFFSET_MIN = 1440
export const MIN_PLAY_MINUTES = 1
export const MAX_PLAY_MINUTES = 60
/**
 * The newest start allowed is this far ahead of the shown clock (15 minutes: NVR clocks often run fast, and a recording can then end
 * "in the future" by the shown clock), the oldest is MAX_AGE_MS behind it.
 */
export const FUTURE_SLACK_MS = 15 * 60_000
/** How many one-second shifts of the start are tried to find a stream nobody is watching (ruling R19). */
export const MAX_START_SHIFTS = 20
const MAX_AGE_MS = 365 * 86_400_000

/** True when a start (a shown-time instant) is not more than 15 minutes ahead of the shown clock and not older than a year. `nowMs` is the real clock. */
export function startInBounds(startMs: number, nowMs: number): boolean {
  const shownNow = shownNowMs(nowMs)
  return Number.isFinite(startMs) && startMs <= shownNow + FUTURE_SLACK_MS && startMs >= shownNow - MAX_AGE_MS
}

export const MSG_CAMERA_NOT_FOUND = 'Camera not found.'
// P2-5b: the login is the recorder's own (a location may have several NVRs).
export const MSG_NO_LOGIN = 'This NVR has no saved login.'
export const MSG_READ_CAMERA = 'Could not read the camera.'
export const MSG_READ_LOGIN = 'Could not read the NVR login.'
const MSG_READ_RECORDINGS = 'Could not read the recordings. Please try again.'
const MSG_BAD_REQUEST = 'That request is not valid.'
export const MSG_BAD_START = 'Choose a start time within the last year, not in the future.'
const MSG_BAD_LENGTH = 'Choose how long to play.'
export const MSG_TOO_BUSY = 'Too many people are watching this recording right now. Try again in a moment.'
/** After this many answers in a row that could not be read, go2rtc is taken to be down. */
const MAX_UNREADABLE_IN_A_ROW = 3


export type PlaybackDeps = {
  /** The person's own signed-in client: whatever it can read is what they may see. */
  rls: AdminClient
  admin: AdminClient
  /** Counts requests per person; a refused request does nothing else. */
  limiter?: RequestLimiter
}
export type LookupDeps = PlaybackDeps & { nvr?: (ep: NvrEndpoint) => NvrClient }
export type OpenPlaybackDeps = PlaybackDeps & {
  go2rtc: Go2rtcClient
  /** Milliseconds since the epoch (default Date.now). */
  now?: () => number
  env?: Record<string, string | undefined>
}
type Who = Pick<Actor, 'id' | 'orgId'>

const validOffset = (n: unknown): n is number => typeof n === 'number' && Number.isInteger(n) && Math.abs(n) <= MAX_OFFSET_MIN

/**
 * PLAYBACK_OFFSET_MIN: whole minutes within a day either way, default 0. Anything else counts as 0 and is reported once in the log.
 * It is the minutes to take off the time shown to people to get the time the NVR expects.
 */
let warnedOffset = false
export function parsePlaybackOffset(raw: string | undefined): number {
  const text = raw?.trim()
  if (text === undefined || text === '') return 0
  const n = /^[+-]?\d{1,4}$/.test(text) ? Number(text) : Number.NaN
  if (validOffset(n)) return n
  if (!warnedOffset) {
    warnedOffset = true
    logger.warn({ event: 'playback_offset_invalid', note: 'PLAYBACK_OFFSET_MIN must be a whole number of minutes between -1440 and 1440; 0 is used' })
  }
  return 0
}

/**
 * P2-5b: the camera (with the channel of its ACTIVE mapping) and the recorder of that mapping (its own address, ports, login and clock
 * offset), the NVR password unless it is not needed, and whether the recorder is the demo (loopback) one.
 */
export type Found = CameraRoute & { password: string | null; demo: boolean }

/**
 * The clock offset to use for this recorder (ruling R13 direction): its own measured or manual `clock_offset_sec` when it has one,
 * else the global default PLAYBACK_OFFSET_MIN (minutes) that the caller passes in.
 */
export function recorderOffset(recorder: Pick<Recorder, 'clock_offset_sec'>, defaultMin: number): ClockOffset {
  return recorder.clock_offset_sec === null ? { offsetMin: defaultMin } : { offsetSec: recorder.clock_offset_sec }
}

/** What looking at recordings needs: cctv.playback (search, calendar, 1x playback) or cctv.export (fast playback is a savable file, D-6a). */
export type RecordingCapability = 'cctv.playback' | 'cctv.export'

/**
 * The camera if this person holds the capability for it (and it and its location are switched on), the recorder of its active mapping,
 * and that NVR's password unless it is not needed. Without the capability the answer is "Camera not found.", the same as for a camera
 * that does not exist (P2-1, AC-2).
 */
export async function findCamera(
  deps: PlaybackDeps,
  cameraId: string,
  /** `later`: no login is read here (the caller reads it with readRecorderLogin, e.g. after its media session exists; P2-4 review m-6). */
  o: { password: 'always' | 'unless-demo' | 'later'; env?: Record<string, string | undefined>; capability: RecordingCapability | readonly RecordingCapability[]; orgId: string },
): Promise<Result<Found>> {
  if (typeof cameraId !== 'string' || !UUID.test(cameraId)) return { ok: false, error: MSG_CAMERA_NOT_FOUND }
  const id = cameraId.toLowerCase()
  // The person's own client answers whether they may use this camera for recordings: every capability asked for must cover it
  // (fast playback asks cctv.export AND cctv.playback, P2-2 fix M-3).
  for (const cap of typeof o.capability === 'string' ? [o.capability] : o.capability) {
    const allowed = await cameraFor(deps.rls, cap, id)
    if (!allowed.ok) return { ok: false, error: MSG_READ_CAMERA }
    if (!allowed.allowed) return { ok: false, error: MSG_CAMERA_NOT_FOUND }
  }
  // Only then the camera's route, with the service role: the recorder of its ACTIVE mapping, with that NVR's address and login, which
  // signed-in people cannot read (AC-10).
  let answer: RouteAnswer | undefined
  try {
    answer = (await resolveCameraRoutes(deps.admin, o.orgId, [id])).get(id)
  } catch {
    logger.error({ event: 'playback_camera_read_failed' })
    return { ok: false, error: MSG_READ_CAMERA }
  }
  if (!answer) return { ok: false, error: MSG_CAMERA_NOT_FOUND }
  // Owner addition: a switched-off NVR is never contacted (no login read, no NVR or go2rtc request). A camera without an active
  // mapping is reached through no NVR at all (never a guessed one).
  if (answer.kind === 'off') return { ok: false, error: MSG_MONITORING_OFF }
  if (answer.kind === 'unmapped') return { ok: false, error: MSG_NOT_MAPPED }
  const { camera, recorder } = answer.route
  if (!recorder.host) return { ok: false, error: MSG_NOT_MAPPED }

  const demo = o.password === 'unless-demo' && isDemoRecorder(recorder, o.env ?? process.env)
  if (demo || o.password === 'later') return { ok: true, camera, recorder, password: null, demo }
  return readRecorderLogin(deps, { camera, recorder, demo })
}

/** The NVR password of a found camera's recorder (service role), in the same plain words as findCamera. */
export async function readRecorderLogin(deps: PlaybackDeps, f: Omit<Found, 'password'>): Promise<Result<Found>> {
  const { camera, recorder, demo } = f
  const read = await readRecorderPassword(deps.admin, recorder.id)
  if (!read.ok) {
    logger.error({ event: 'playback_credential_failed', location: camera.code, recorder: recorder.id, errorCode: read.code })
    return { ok: false, error: await recorderMessage(deps.rls, recorder.id, MSG_READ_LOGIN, 'credential_read_failed') }
  }
  if (!read.password) return { ok: false, error: await recorderMessage(deps.rls, recorder.id, MSG_NO_LOGIN, 'no_saved_login') }
  return { ok: true, camera, recorder, password: read.password, demo }
}

// ── NVR and credential trouble, for whom (P2-2 fix round 1, I-2) ──────────────
// Which login is saved, whether the NVR refused it, whether it answered: recorder information, for people with the IT view of THAT
// recorder (it.inventory.view or it.monitoring.view at organisation, region, cluster, location or recorder scope — the same rule as
// it_view_recorder_ids, review I-1 — asked as the person). Everybody else gets one message in camera terms. The kind of trouble is
// always logged on the server (never its text).
export const MSG_RECORDINGS_UNREACHABLE = 'The recordings of this camera cannot be reached right now.'

/** Whether the person has the IT view of the recorder (has_capability_for(…, 'recorder', id)), asked in the database. */
export async function recorderDetailsAllowed(rls: AdminClient, recorderId: string): Promise<boolean> {
  for (const cap of IT_VIEW) {
    const r = await recorderFor(rls, cap, recorderId)
    if (r.ok && r.allowed) return true
  }
  return false
}

/** `specific` for a person with the IT view of the recorder, the camera-terms message for everybody else. */
export async function recorderMessage(rls: AdminClient, recorderId: string, specific: string, kind: string): Promise<string> {
  logger.warn({ event: 'recorder_problem', kind })
  return (await recorderDetailsAllowed(rls, recorderId)) ? specific : MSG_RECORDINGS_UNREACHABLE
}

/** NVR trouble in plain words (camera terms without the IT view). Anything unexpected is logged by its kind only: its text can carry an address or a password. */
async function nvrFailure(e: unknown, event: string, rls: AdminClient, recorderId: string): Promise<{ ok: false; error: string }> {
  if (e instanceof NvrError) return { ok: false, error: await recorderMessage(rls, recorderId, describeNvrError(e), `nvr_${e.kind}`) }
  logger.error({ event, errorName: e instanceof Error ? e.name : typeof e })
  return { ok: false, error: MSG_READ_RECORDINGS }
}

const defaultNvr = (ep: NvrEndpoint) => new NvrClient(ep)

/**
 * Days of the month that the NVR's own calendar marks as having recordings for this camera (1 to 31). These are NVR days, not days as
 * shown (they differ by the offset near midnight), so they are only a hint: a screen may mark them but must let people open any day.
 */
export async function listRecordedDays(deps: LookupDeps, actor: Who, cameraId: string, year: number, month: number, offsetMin: number): Promise<Result<{ days: number[] }>> {
  if (!Number.isInteger(year) || year < 2000 || year > 2100 || !Number.isInteger(month) || month < 1 || month > 12 || !validOffset(offsetMin)) return { ok: false, error: MSG_BAD_REQUEST }
  if (deps.limiter && !deps.limiter.allow(actor.id)) return { ok: false, error: MSG_TOO_MANY_REQUESTS }
  const c = await findCamera(deps, cameraId, { password: 'always', capability: 'cctv.playback', orgId: actor.orgId })
  if (!c.ok) return c
  const { camera, recorder, password } = c
  try {
    const client = (deps.nvr ?? defaultNvr)({ host: recorder.host!, port: recorder.http_port, username: recorder.username, password: password! })
    return { ok: true, days: await recordedDays(client, { channel: camera.channel, year, month }) }
  } catch (e) {
    return await nvrFailure(e, 'playback_days_failed', deps.rls, recorder.id)
  }
}

/**
 * The recordings that touch one day (`yyyy-mm-dd`, as shown), earliest first, as ISO strings of SHOWN time: the UTC clock fields are the
 * wall clock, which is NVR time + offsetMin. They are not cut at midnight. `truncated`: the list may be incomplete (too many recordings, only
 * the first part is held). `skipped`: recordings the NVR listed that could not be read. The NVR's own playback address never leaves here.
 */
export async function listDaySegments(
  deps: LookupDeps,
  actor: Who,
  cameraId: string,
  day: string,
  offsetMin: number,
): Promise<Result<{ segments: { start: string; end: string }[]; truncated: boolean; skipped: number }>> {
  if (!parseDay(day) || !validOffset(offsetMin)) return { ok: false, error: MSG_BAD_REQUEST }
  if (deps.limiter && !deps.limiter.allow(actor.id)) return { ok: false, error: MSG_TOO_MANY_REQUESTS }
  const c = await findCamera(deps, cameraId, { password: 'always', capability: 'cctv.playback', orgId: actor.orgId })
  if (!c.ok) return c
  const { camera, recorder, password } = c
  try {
    const client = (deps.nvr ?? defaultNvr)({ host: recorder.host!, port: recorder.http_port, username: recorder.username, password: password! })
    // The recorder's own clock offset when it has one (P2-5b), else the default `offsetMin`.
    const found = await findSegments(client, { channel: camera.channel, day, ...recorderOffset(recorder, offsetMin) })
    return {
      ok: true,
      segments: found.segments.map((s) => ({ start: s.start.toISOString(), end: s.end.toISOString() })), // only the times: never `uri`
      truncated: found.truncated,
      skipped: found.skipped,
    }
  } catch (e) {
    return await nvrFailure(e, 'playback_segments_failed', deps.rls, recorder.id)
  }
}

/**
 * Starts playback of `minutes` (1 to 60) from a shown-time `start` (not more than 15 minutes ahead of the shown clock, not older than a
 * year): registers `pb_<camera>_<start in seconds>` with go2rtc, pointing at the NVR's playback address (shown time - offsetMin), and signs
 * a `pb` token for it that names its media session and connects within 90 seconds (P2-4). The address with the NVR password stays
 * inside this function.
 *
 * One go2rtc stream has one running source, and everybody watching it sees the same moment of it. So a request is only given a stream that
 * nobody is using (ruling R19): when the stream of that name already has a viewer or a running source, or its state cannot be read, the
 * start is moved on by one second (up to 20 tries; one second cannot be seen) and the token and the NVR address carry the moved start. An
 * idle stream with the same source is reused. After 20 tries the answer is "too many people are watching".
 */
export async function openPlayback(deps: OpenPlaybackDeps, actor: Who, cameraId: string, start: Date, minutes: number, offsetMin: number): Promise<Result<{ token: string; name: string }>> {
  const secret = getSecret('stream_token')
  if (!secret) return { ok: false, error: MSG_NOT_SET_UP }
  if (!validOffset(offsetMin)) return { ok: false, error: MSG_BAD_REQUEST }
  if (typeof minutes !== 'number' || !Number.isFinite(minutes)) return { ok: false, error: MSG_BAD_LENGTH }
  if (!(start instanceof Date) || !Number.isFinite(start.getTime())) return { ok: false, error: MSG_BAD_START }
  const now = deps.now ?? Date.now
  if (!startInBounds(start.getTime(), now())) return { ok: false, error: MSG_BAD_START }
  if (deps.limiter && !deps.limiter.allow(actor.id)) return { ok: false, error: MSG_TOO_MANY_REQUESTS }

  const length = Math.min(MAX_PLAY_MINUTES, Math.max(MIN_PLAY_MINUTES, Math.round(minutes)))
  const wanted = Math.floor(start.getTime() / 1000)

  const c = await findCamera(deps, cameraId, { password: 'unless-demo', env: deps.env, capability: 'cctv.playback', orgId: actor.orgId })
  if (!c.ok) return c
  const { camera, recorder, password, demo } = c
  try {
    let unreadable = 0
    for (let shift = 0; shift < MAX_START_SHIFTS; shift++) {
      const s = wanted + shift
      const e = s + length * 60
      const name = streamName({ c: camera.id, k: 'pb', s })
      let busy: boolean
      try {
        busy = (await deps.go2rtc.inspect(name)).busy
        unreadable = 0
      } catch {
        busy = true // the state cannot be read: the stream is taken to be in use
        if (++unreadable >= MAX_UNREADABLE_IN_A_ROW) return { ok: false, error: MSG_UNAVAILABLE } // go2rtc is not answering at all
      }
      if (busy) continue
      // P2-4 (D-3, AC-14): this playback's media session, made after the database checked cctv.playback for this person once more;
      // the gateway opens it when the socket arrives and re-checks it every 15 s. Refused: the same answer as no right at all.
      let sid: string | undefined
      try {
        sid = (await createMediaSessions(deps.admin, { orgId: actor.orgId, userId: actor.id, kind: 'playback', cameras: [{ id: camera.id, stream: name }] })).get(camera.id)
      } catch {
        logger.error({ event: 'open_playback_sessions_failed' })
        return { ok: false, error: MSG_ACCESS_CHECK_FAILED }
      }
      if (!sid) return { ok: false, error: MSG_CAMERA_NOT_FOUND }
      const src = demo
        ? demoSource(camera.channel, `${camera.id}:${s}`)
        : buildPlaybackUrl({
            host: recorder.host!, port: recorder.rtsp_port, username: recorder.username, password: password!, channel: camera.channel,
            start: new Date(s * 1000), end: new Date(e * 1000), ...recorderOffset(recorder, offsetMin),
          })
      await deps.go2rtc.register(name, src, { keepExisting: demo })
      const token = signStreamToken({ sid, u: actor.id, c: camera.id, k: 'pb', exp: Math.floor(now() / 1000) + TOKEN_LIFETIME_SEC, s, e }, secret)
      // Streams nobody has watched for a long time are removed from go2rtc (at most once a minute; never waits, never fails the request).
      // (go2rtc's idle clock is the machine clock, so the real time is used here, not the injected one.)
      void deps.go2rtc.prune().catch(() => {})
      return { ok: true, token, name }
    }
    return { ok: false, error: MSG_TOO_BUSY }
  } catch {
    logger.error({ event: 'open_playback_failed', location: camera.code, recorder: recorder.id, channel: camera.channel }) // no address, no error text: they can carry a password
    return { ok: false, error: MSG_UNAVAILABLE }
  }
}
