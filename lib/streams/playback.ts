import type { Actor, AdminClient, Result } from '@/lib/admin/types'
import { describeNvrError, NvrClient, NvrError, type NvrEndpoint } from '@/lib/nvr/client'
import { findSegments, recordedDays } from '@/lib/nvr/playback'
import { logger } from '@/lib/observability/logger'
import { getSecret } from '@/lib/secrets'
import type { Go2rtcClient } from '@/lib/streams/go2rtc'
import { MSG_NOT_SET_UP, MSG_UNAVAILABLE } from '@/lib/streams/open'
import { MSG_TOO_MANY_REQUESTS, type RequestLimiter } from '@/lib/streams/request-limit'
import { buildPlaybackUrl, demoSource, isDemoStore } from '@/lib/streams/source'
import { parseDay, shownNowMs } from '@/lib/streams/timeline'
import { signStreamToken, streamName, TOKEN_LIFETIME_SEC } from '@/lib/streams/token'

// Playback by day and time. Which cameras may be looked at is decided by the person's own client (row-level security); the NVR password is
// read with the service-role call only for a camera that passed that check, is used for this one call and goes nowhere else.
//
// TIMES (ruling R13). Every time that comes back from here, and the start that goes in, is a "shown time": a plain instant whose UTC clock
// fields are the wall clock people see (India time). It is NVR time + `offsetMin`, so it is NOT the real UTC instant unless the offset is 0
// and the machine clock were also on that clock. The NVR is asked for shown time - offsetMin. Nothing converts between time zones.

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const MAX_OFFSET_MIN = 1440
export const MIN_PLAY_MINUTES = 1
export const MAX_PLAY_MINUTES = 60
/** The newest start allowed is this far ahead of the shown clock, the oldest this far behind it. */
const FUTURE_SLACK_MS = 60_000
const MAX_AGE_MS = 365 * 86_400_000

export const MSG_CAMERA_NOT_FOUND = 'Camera not found.'
export const MSG_NO_LOGIN = 'This store has no saved NVR login.'
const MSG_READ_CAMERA = 'Could not read the camera.'
const MSG_READ_LOGIN = 'Could not read the NVR login.'
const MSG_READ_RECORDINGS = 'Could not read the recordings. Please try again.'
const MSG_BAD_REQUEST = 'That request is not valid.'
const MSG_BAD_START = 'Choose a start time within the last year, not in the future.'
const MSG_BAD_LENGTH = 'Choose how long to play.'

type StoreRow = { code: string; nvr_ip: string; http_port: number; rtsp_port: number; nvr_username: string }
type CameraRow = { id: string; name: string; channel: number; store_id: string; stores: StoreRow | null }

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

type Found = { camera: CameraRow & { stores: StoreRow }; password: string | null; demo: boolean }

/** The camera if this person may see it (and it and its store are switched on), and the NVR password unless it is not needed. */
async function findCamera(deps: PlaybackDeps, cameraId: string, o: { password: 'always' | 'unless-demo'; env?: Record<string, string | undefined> }): Promise<Result<Found>> {
  if (typeof cameraId !== 'string' || !UUID.test(cameraId)) return { ok: false, error: MSG_CAMERA_NOT_FOUND }
  const found = await deps.rls
    .from('cameras')
    .select('id, name, channel, store_id, stores!inner(code, nvr_ip, http_port, rtsp_port, nvr_username, is_active)')
    .eq('id', cameraId.toLowerCase())
    .eq('is_active', true)
    .eq('stores.is_active', true)
    .maybeSingle()
  if (found.error) {
    logger.error({ event: 'playback_camera_read_failed', errorCode: found.error.code })
    return { ok: false, error: MSG_READ_CAMERA }
  }
  const row = found.data as unknown as CameraRow | null
  if (!row || !row.stores) return { ok: false, error: MSG_CAMERA_NOT_FOUND }
  const camera = row as Found['camera']

  const demo = o.password === 'unless-demo' && isDemoStore({ code: camera.stores.code, nvr_ip: camera.stores.nvr_ip }, o.env ?? process.env)
  if (demo) return { ok: true, camera, password: null, demo }
  const { data, error } = await deps.admin.rpc('nvr_read_credential', { p_store: camera.store_id })
  if (error) {
    logger.error({ event: 'playback_credential_failed', store: camera.stores.code, errorCode: error.code })
    return { ok: false, error: MSG_READ_LOGIN }
  }
  if (typeof data !== 'string' || data === '') return { ok: false, error: MSG_NO_LOGIN }
  return { ok: true, camera, password: data, demo }
}

/** NVR trouble in plain words. Anything unexpected is logged by its kind only: its text can carry an address or a password. */
function nvrFailure(e: unknown, event: string): { ok: false; error: string } {
  if (e instanceof NvrError) return { ok: false, error: describeNvrError(e) }
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
  const c = await findCamera(deps, cameraId, { password: 'always' })
  if (!c.ok) return c
  const { camera, password } = c
  try {
    const client = (deps.nvr ?? defaultNvr)({ host: camera.stores.nvr_ip, port: camera.stores.http_port, username: camera.stores.nvr_username, password: password! })
    return { ok: true, days: await recordedDays(client, { channel: camera.channel, year, month }) }
  } catch (e) {
    return nvrFailure(e, 'playback_days_failed')
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
  const c = await findCamera(deps, cameraId, { password: 'always' })
  if (!c.ok) return c
  const { camera, password } = c
  try {
    const client = (deps.nvr ?? defaultNvr)({ host: camera.stores.nvr_ip, port: camera.stores.http_port, username: camera.stores.nvr_username, password: password! })
    const found = await findSegments(client, { channel: camera.channel, day, offsetMin })
    return {
      ok: true,
      segments: found.segments.map((s) => ({ start: s.start.toISOString(), end: s.end.toISOString() })), // only the times: never `uri`
      truncated: found.truncated,
      skipped: found.skipped,
    }
  } catch (e) {
    return nvrFailure(e, 'playback_segments_failed')
  }
}

/**
 * Starts playback of `minutes` (1 to 60) from a shown-time `start` (not in the future, not older than a year, both on the shown clock):
 * registers `pb_<camera>_<start in seconds>` with go2rtc, pointing at the NVR's playback address (shown time - offsetMin), and signs a
 * 10 minute `pb` token for it. An unchanged stream is not registered twice. The address with the NVR password stays inside this function.
 */
export async function openPlayback(deps: OpenPlaybackDeps, actor: Who, cameraId: string, start: Date, minutes: number, offsetMin: number): Promise<Result<{ token: string; name: string }>> {
  const secret = getSecret('stream_token')
  if (!secret) return { ok: false, error: MSG_NOT_SET_UP }
  if (!validOffset(offsetMin)) return { ok: false, error: MSG_BAD_REQUEST }
  if (typeof minutes !== 'number' || !Number.isFinite(minutes)) return { ok: false, error: MSG_BAD_LENGTH }
  if (!(start instanceof Date) || !Number.isFinite(start.getTime())) return { ok: false, error: MSG_BAD_START }
  const now = deps.now ?? Date.now
  const shownNow = shownNowMs(now())
  if (start.getTime() > shownNow + FUTURE_SLACK_MS || start.getTime() < shownNow - MAX_AGE_MS) return { ok: false, error: MSG_BAD_START }
  if (deps.limiter && !deps.limiter.allow(actor.id)) return { ok: false, error: MSG_TOO_MANY_REQUESTS }

  const length = Math.min(MAX_PLAY_MINUTES, Math.max(MIN_PLAY_MINUTES, Math.round(minutes)))
  const s = Math.floor(start.getTime() / 1000)
  const e = s + length * 60

  const c = await findCamera(deps, cameraId, { password: 'unless-demo', env: deps.env })
  if (!c.ok) return c
  const { camera, password, demo } = c
  const store = camera.stores
  try {
    const src = demo
      ? demoSource(camera.channel, `${camera.id}:${s}`)
      : buildPlaybackUrl({ host: store.nvr_ip, port: store.rtsp_port, username: store.nvr_username, password: password!, channel: camera.channel, start: new Date(s * 1000), end: new Date(e * 1000), offsetMin })
    const name = streamName({ c: camera.id, k: 'pb', s })
    await deps.go2rtc.register(name, src, { keepExisting: demo })
    const token = signStreamToken({ u: actor.id, c: camera.id, k: 'pb', exp: Math.floor(now() / 1000) + TOKEN_LIFETIME_SEC, s, e }, secret)
    // Streams nobody has watched for a long time are removed from go2rtc (at most once a minute; never waits, never fails the request).
    // (go2rtc's idle clock is the machine clock, so the real time is used here, not the injected one.)
    void deps.go2rtc.prune().catch(() => {})
    return { ok: true, token, name }
  } catch {
    logger.error({ event: 'open_playback_failed', store: store.code, channel: camera.channel }) // no address, no error text: they can carry a password
    return { ok: false, error: MSG_UNAVAILABLE }
  }
}
