import type { AdminClient, Result } from '@/lib/admin/types'
import { auditAccess } from '@/lib/auth/access-audit'
import { MSG_ACCESS_CHECK_FAILED } from '@/lib/auth/resource'
import { MSG_MONITORING_OFF, MSG_NOT_MAPPED, type CameraRoute } from '@/lib/inventory/recorders'
import { describeNvrError, MAX_DOWNLOAD_BYTES, MAX_DOWNLOAD_MS, NvrClient, NvrError, type NvrEndpoint } from '@/lib/nvr/client'
import { guardNvrClient, MSG_LOGIN_STATE_UNREADABLE, MSG_NVR_LOGIN_CHECKING, MSG_NVR_LOGIN_REFUSED, MSG_NVR_LOGIN_UNEXPLAINED } from '@/lib/nvr/login-guard'
import { clockOffsetMs, findSegments } from '@/lib/nvr/playback'
import { logger } from '@/lib/observability/logger'
import { processSingleton } from '@/lib/process-singleton'
import { MSG_NO_FFMPEG, videoFamily, type ProgramLookup, type SpawnFn } from '@/lib/streams/ffmpeg'
import { findCamera, readRecorderLogin, MSG_CAMERA_NOT_FOUND, MSG_BAD_START, MSG_NO_LOGIN, MSG_RECORDINGS_UNREACHABLE, parsePlaybackOffset, recorderMessage, recorderOffset, startInBounds } from '@/lib/streams/playback'
import { adminRegistry, createMediaSessions, type RegistryClient } from '@/lib/streams/registry'
import { ffmpegRemux, type RemuxAdapter } from '@/lib/streams/remux'
import { MSG_TOO_MANY_REQUESTS, type RequestLimiter } from '@/lib/streams/request-limit'
import { MSG_FAST_NOT_SET_UP } from '@/lib/streams/speed'
import { watchSession, type SessionWatch } from '@/lib/streams/session-watch'
import { parseStartIso } from '@/lib/streams/timeline'

// A recording from the NVR as a fragmented MP4. The NVR sends a recording in one piece, much faster than it plays; the remux adapter
// (lib/streams/remux.ts: ffmpeg `-c:v copy`, no re-encoding) rewraps it as a fragmented MP4 while it arrives.
//
// Two ways out, one core (`deliverRecording`, shared with lib/streams/fast.ts):
//   GET /api/vod (this file's serveVod)            a SAVEABLE video/mp4: needs cctv.export AND cctv.playback for the camera (ruling M-3;
//                                                  decision D-L1 keeps it for export only, ruling E-1: administrators only). The Playback
//                                                  screen no longer uses it.
//   GET /api/playback/stream (lib/streams/fast.ts) fast playback 2x-16x for cctv.playback (D-L1): a token-bound stream, not a file.
//
// What is trusted: nothing that comes from the NVR. Its playback address (`playbackURI`) is only ever put, escaped and capped, into the
// body of ONE request to the SAME NVR; it is never fetched, logged or sent to a browser. What the browser sends (camera, start, minutes)
// is checked before anything else happens, and the camera must be one the person may use (checked by the database as the person).

// The ffmpeg program moved to lib/streams/ffmpeg.ts (P4-L2); everything is still available from here.
export {
  AVAILABILITY_TTL_MS, buildFfmpegArgs, classifyFfmpegFailure, createFfmpegCheck, createSpawn, defaultSpawn, fastPlaybackAvailable, FFMPEG_MIN_MAJOR, ffmpegVersionOk, FIRST_BYTE_MS,
  FORMAT_WHITELIST, KILL_GRACE_MS, MSG_FFMPEG_PATH, MSG_NO_FFMPEG, resolveFfmpeg, sanitizeStderr, SOURCE_IDLE_MS, startConversion, STDERR_CAP_BYTES,
  videoFamily, VOD_MAX_MS,
} from '@/lib/streams/ffmpeg'
export type { ConversionFailure, ConversionOptions, ConversionResult, FfmpegProgram, ProgramLookup, SpawnFn } from '@/lib/streams/ffmpeg'

/** Longest clip. */
export const VOD_MAX_MINUTES = 30
export const VOD_MIN_MINUTES = 1
/** Running conversions: this many per person and this many in all (export and fast playback share them). */
export const MAX_CONVERSIONS_PER_PERSON = 1
export const MAX_CONVERSIONS_TOTAL = 8
/** The longest playback address that is passed on to the NVR. */
export const MAX_PLAYBACK_URI = 512
/** A person's new conversion waits at most this long for their previous one to end. */
export const SUPERSEDE_WAIT_MS = 3_000

export const MSG_VOD_BAD_REQUEST = 'That request is not valid.'
export const MSG_VOD_BAD_LENGTH = `Choose how long to play, from ${VOD_MIN_MINUTES} to ${VOD_MAX_MINUTES} minutes.`
export const MSG_NO_RECORDING = 'There is no recording at that time.'
export const MSG_NOT_DOWNLOADABLE = 'This recording cannot be played at a faster speed.'
export const MSG_ALREADY_RUNNING = 'You already have a fast playback running. Stop it first, then try again.'
export const MSG_SERVER_BUSY = 'The server is busy with other fast playbacks. Try again in a moment.'
export const MSG_FORMAT_UNSUPPORTED = "This recording's format is not supported for fast playback."
const MSG_NVR_FAILED = 'Could not read the recordings. Please try again.'
const MSG_CONVERT_FAILED = 'The recording could not be converted for fast playback.'
const DOWNLOAD_PATH = '/ISAPI/ContentMgmt/download'

// ── limits ───────────────────────────────────────────────────────────────────

export type ConversionSlot = { ok: true; release: () => void } | { ok: false; reason: 'person' | 'total' }
export type ConversionLimiter = {
  /**
   * Takes a place for this person (the caller must `release` it exactly when the work is over; releasing twice does nothing). `stop` is
   * what `supersede` calls to ask the work to end.
   */
  acquire(key: string, stop?: () => void): ConversionSlot
  /** Would a place be given, without taking it. `ignoreOwn`: the person's own running conversions do not count (they are about to be ended). */
  peek(key: string, o?: { ignoreOwn?: boolean }): { ok: true } | { ok: false; reason: 'person' | 'total' }
  /** Asks every running conversion of this person to end and waits (at most `waitMs`) until their places are given back. True when none is left. */
  supersede(key: string, waitMs: number): Promise<boolean>
  readonly running: number
}

/** Counts running conversions: `perPerson` for each person and `total` in all. In this process only. */
export function createConversionLimiter(perPerson = MAX_CONVERSIONS_PER_PERSON, total = MAX_CONVERSIONS_TOTAL): ConversionLimiter {
  const byPerson = new Map<string, Set<{ stop?: () => void }>>()
  const waiting = new Map<string, (() => void)[]>()
  let sum = 0
  const own = (key: string) => byPerson.get(key)?.size ?? 0
  const refusal = (key: string, ignoreOwn = false): 'person' | 'total' | null => {
    if (!ignoreOwn && own(key) >= perPerson) return 'person'
    return sum - (ignoreOwn ? own(key) : 0) >= total ? 'total' : null
  }
  return {
    acquire(key, stop) {
      const why = refusal(key)
      if (why) return { ok: false, reason: why }
      const entry = { stop }
      const set = byPerson.get(key) ?? new Set()
      set.add(entry)
      byPerson.set(key, set)
      sum++
      let released = false
      return {
        ok: true,
        release() {
          if (released) return
          released = true
          sum--
          set.delete(entry)
          if (set.size === 0) {
            byPerson.delete(key)
            for (const wake of waiting.get(key) ?? []) wake()
            waiting.delete(key)
          }
        },
      }
    },
    peek(key, o) {
      const why = refusal(key, o?.ignoreOwn)
      return why ? { ok: false, reason: why } : { ok: true }
    },
    supersede(key, waitMs) {
      const set = byPerson.get(key)
      if (!set || set.size === 0) return Promise.resolve(true)
      for (const entry of [...set]) {
        try {
          entry.stop?.()
        } catch {
          // the work is ending anyway
        }
      }
      return new Promise<boolean>((resolve) => {
        const timer = setTimeout(() => resolve(false), waitMs)
        timer.unref?.()
        const list = waiting.get(key) ?? []
        list.push(() => {
          clearTimeout(timer)
          resolve(true)
        })
        waiting.set(key, list)
      })
    },
    get running() {
      return sum
    },
  }
}

const poolSize = (raw: string | undefined, fallback: number) => {
  const n = /^\s*\d{1,3}\s*$/.test(raw ?? '') ? Number(raw) : Number.NaN
  return Number.isInteger(n) && n >= 1 && n <= 64 ? n : fallback
}

/**
 * The EXPORT pool (/api/vod, cctv.export): its conversions in this process, one count for route handlers, actions and reloaded modules
 * alike (EXPORT_MAX_CONVERSIONS, default 8). P4-L2 review I-2: viewers' fast playback has its own pool, so viewers never block exports.
 */
export const exportConversionLimiter = (): ConversionLimiter =>
  processSingleton('cctv.conversionLimiter', () => createConversionLimiter(MAX_CONVERSIONS_PER_PERSON, poolSize(process.env.EXPORT_MAX_CONVERSIONS, MAX_CONVERSIONS_TOTAL)))
/** The export pool as it was when this module loaded (kept for older callers). */
export const conversionLimiter: ConversionLimiter = exportConversionLimiter()
/** The VIEWERS' pool (fast playback, cctv.playback): FAST_PLAYBACK_MAX_CONVERSIONS, default 8; one per person. */
export const fastConversionLimiter = (): ConversionLimiter =>
  processSingleton('cctv.fastConversionLimiter', () => createConversionLimiter(MAX_CONVERSIONS_PER_PERSON, poolSize(process.env.FAST_PLAYBACK_MAX_CONVERSIONS, MAX_CONVERSIONS_TOTAL)))

// ── the NVR's playback address ───────────────────────────────────────────────

const URI = /^(?:rtsp|https?):\/\/[^\s\u0000-\u001f\u007f]+$/i
const XML_ENTITIES: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' }
const escapeXml = (s: string) => s.replace(/[&<>"']/g, (c) => XML_ENTITIES[c])
const two = (n: number) => String(n).padStart(2, '0')

/** An NVR instant as the NVR writes it in a playback address: `yyyymmddThhmmssZ`. */
function nvrStamp(d: Date): string {
  return `${String(d.getUTCFullYear()).padStart(4, '0')}${two(d.getUTCMonth() + 1)}${two(d.getUTCDate())}T${two(d.getUTCHours())}${two(d.getUTCMinutes())}${two(d.getUTCSeconds())}Z`
}

/**
 * The NVR's playback address with its `starttime` and `endtime` replaced by `from` and `to` (NVR instants), so that only the part wanted
 * is downloaded, not the whole recording file. An address that does not have both is refused (null): it would download a whole file of
 * unknown size. The replacement values are made here; nothing else of the address is read or changed.
 */
export function clipPlaybackUri(uri: string, from: Date, to: Date): string | null {
  if (!/[?&]starttime=/i.test(uri) || !/[?&]endtime=/i.test(uri)) return null
  return uri.replace(/([?&]starttime=)[^&]*/i, (_m, head: string) => head + nvrStamp(from)).replace(/([?&]endtime=)[^&]*/i, (_m, head: string) => head + nvrStamp(to))
}

/**
 * The body of the download request. The playback address came from the NVR, so it is treated as hostile: it must be an rtsp, http or
 * https address of at most 512 characters with no space or control character, and it is escaped (&amp; &lt; &gt; &quot; &apos;). It goes
 * nowhere but this body. Anything else is a plain Error that does not echo the address.
 */
export function buildDownloadBody(uri: string): string {
  if (typeof uri !== 'string' || uri.length === 0 || uri.length > MAX_PLAYBACK_URI || !URI.test(uri)) throw new Error('Invalid playback address.')
  return `<?xml version='1.0' encoding='utf-8'?><downloadRequest version='1.0' xmlns='http://www.isapi.org/ver20/XMLSchema'><playbackURI>${escapeXml(uri)}</playbackURI></downloadRequest>`
}

// ── the request ──────────────────────────────────────────────────────────────

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export type VodQuery = { camera: string; start: Date; minutes: number; probe: boolean }

/**
 * Reads `camera`, `start` and `minutes` (and the optional `probe=1`) from the query. Each must appear exactly once. `start` is a strict
 * ISO time ending in Z, read as a shown time (see lib/streams/playback.ts); `minutes` is a whole number from 1 to 30.
 */
export function parseVodQuery(params: URLSearchParams): Result<{ query: VodQuery }> {
  const one = (name: string): string | null => {
    const all = params.getAll(name)
    return all.length === 1 ? all[0] : null
  }
  const camera = one('camera')
  if (camera === null || !UUID.test(camera)) return { ok: false, error: MSG_CAMERA_NOT_FOUND }
  const startText = one('start')
  const start = startText === null ? null : parseStartIso(startText)
  if (start === null) return { ok: false, error: MSG_VOD_BAD_REQUEST }
  const minutesText = one('minutes')
  const minutes = minutesText !== null && /^\d{1,2}$/.test(minutesText) ? Number(minutesText) : Number.NaN
  if (!Number.isInteger(minutes) || minutes < VOD_MIN_MINUTES || minutes > VOD_MAX_MINUTES) return { ok: false, error: MSG_VOD_BAD_LENGTH }
  const probeText = params.getAll('probe')
  if (probeText.length > 1 || (probeText.length === 1 && probeText[0] !== '1')) return { ok: false, error: MSG_VOD_BAD_REQUEST }
  return { ok: true, query: { camera: camera.toLowerCase(), start, minutes, probe: probeText.length === 1 } }
}

export type VodDeps = {
  /** The person's own signed-in client: whatever it can read is what they may see. */
  rls: AdminClient
  admin: AdminClient
  /** The export count of video requests per person (lib/streams/request-limit.ts exportRequestLimiter). */
  limiter?: RequestLimiter
  conversions?: ConversionLimiter
  nvr?: (ep: NvrEndpoint) => NvrClient
  /** The remux step (P4-L2, lib/streams/remux.ts). Default: ffmpeg with `spawn`, `lookup` and `ffmpegAvailable` below. */
  remux?: RemuxAdapter
  spawn?: SpawnFn
  /** Settings (default process.env): FFMPEG, PATH and PLAYBACK_OFFSET_MIN. */
  env?: Record<string, string | undefined>
  /** Where to look for the program (tests). */
  lookup?: ProgramLookup
  /** Milliseconds since the epoch (default Date.now). */
  now?: () => number
  /** Minutes to take off a shown time to get the NVR's time (default: PLAYBACK_OFFSET_MIN from `env`). */
  offsetMin?: number
  /** Whether ffmpeg runs: asked before the NVR is asked for the download, and by `probe=1`. Default: the shared check, remembered for a minute (without it when `spawn` is given, where a start that fails is answered the same way). */
  ffmpegAvailable?: (env: Record<string, string | undefined>) => Promise<boolean>
  /** The media session registry (default: through `admin`). P2-4: every download is a session of kind vod, re-checked while it runs. */
  registry?: RegistryClient
  /** Test settings (validateMs / failClosedMs: the session re-check, default 15 s / 45 s). */
  timing?: {
    maxMs?: number; transferMs?: number; firstByteMs?: number; idleMs?: number; killGraceMs?: number; maxBytes?: number; supersedeMs?: number; validateMs?: number; failClosedMs?: number
    /** Fast playback (review round 1): the pacing burst, the byte cap per second of recording, the viewer-idle time. */
    burstSec?: number; maxBytesPerSec?: number; viewerIdleMs?: number
  }
}

/** P2-4 (D-3): how often a running download's media session is re-checked, and how long without an answer before it is cut. */
export const VOD_VALIDATE_EVERY_MS = 15_000
export const VOD_FAIL_CLOSED_AFTER_MS = 45_000

export const VOD_HEADERS = { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Cross-Origin-Resource-Policy': 'same-origin' }
const fail = (status: number, error: string) => Response.json({ error }, { status, headers: VOD_HEADERS })

/** The answer for a camera that could not be used, in the status the brief and the reviews fixed. */
export function cameraFailure(error: string): Response {
  if (error === MSG_CAMERA_NOT_FOUND) return fail(404, error)
  if (error === MSG_NO_LOGIN) return fail(409, error)
  if (error === MSG_RECORDINGS_UNREACHABLE) return fail(502, error) // camera terms: no status that tells login trouble apart (fix I-2)
  if (error === MSG_MONITORING_OFF) return fail(409, error) // owner addition: the NVR is switched off, nothing was contacted
  if (error === MSG_NOT_MAPPED) return fail(409, error) // P2-5b: the camera has no active mapping, so there is no NVR to ask
  // Final fix X (NB-1): the NVR's login stands refused (shared back-off) or is being checked: NVR trouble, like the NVR's own refusal.
  // Round 3 (NB-12): also the words of an NVR that waits because of the gateway's fail-safe.
  if (error === MSG_NVR_LOGIN_REFUSED || error === MSG_NVR_LOGIN_UNEXPLAINED || error === MSG_NVR_LOGIN_CHECKING || error === MSG_LOGIN_STATE_UNREADABLE) return fail(502, error)
  return fail(500, error)
}

/**
 * The answer to GET /api/vod for a signed-in person (the route has already checked who they are). Either a JSON error with a plain
 * message, or `video/mp4` that is streamed while it is made. `signal` is the request's own: it aborts when the person goes away.
 *
 * Order: the input is checked; the person's count of video requests; the camera (cctv.export AND cctv.playback for it, checked by the
 * database as the person: a camera they may not export is the same "not found" as one that does not exist); the media session (kind vod);
 * then the shared core (deliverRecording).
 *
 * `probe=1` does everything except start the remux and the download, and answers `{ ok: true, codec }` (codec: 'h264', 'h265' or null)
 * or the same JSON error. It takes no place and ignores the person's own running conversion.
 */
export async function serveVod(deps: VodDeps, actor: { id: string; orgId: string; aal2?: boolean }, query: VodQuery, signal?: AbortSignal): Promise<Response> {
  const now = deps.now ?? Date.now
  if (!startInBounds(query.start.getTime(), now())) return fail(400, MSG_BAD_START)
  if (deps.limiter && !(await deps.limiter.allow(actor.id))) return fail(429, MSG_TOO_MANY_REQUESTS)

  // A saveable MP4 of a recording: cctv.export AND cctv.playback for the camera (ruling M-3; D-L1 keeps this rule for the file only).
  // P2-4 review m-6: the NVR login is read only after the download's media session exists (fail closed before touching secrets).
  const c = await findCamera(deps, query.camera, { password: 'later', capability: ['cctv.export', 'cctv.playback'], orgId: actor.orgId })
  if (!c.ok) {
    // A camera the person may not export (or that does not exist) is recorded as a refusal (P2-2, brief item 7).
    if (c.error === MSG_CAMERA_NOT_FOUND) await auditAccess(deps.admin, { orgId: actor.orgId, actorId: actor.id, action: 'cctv_export_denied', capability: 'cctv.export', cameraIds: [query.camera], detail: { reason: 'camera' } })
    return cameraFailure(c.error)
  }
  const { camera, recorder } = c
  if (signal?.aborted) return new Response(null, { status: 499 })

  // P2-4 (D-3, AC-14, brief item 4): a download is a media session of kind vod (cctv.export AND cctv.playback, checked again by the
  // database for this person), opened at once and re-checked while the transfer runs. The probe downloads nothing and makes none.
  const registry = deps.registry ?? adminRegistry(deps.admin)
  let sid: string | null = null
  if (!query.probe) {
    try {
      // P3-1: cctv.export requires MFA; the session records the verified level so the registry's checks count it while the switch is on.
      sid = (await createMediaSessions(deps.admin, { orgId: actor.orgId, userId: actor.id, kind: 'vod', cameras: [{ id: camera.id, stream: null }], maxSec: Math.ceil(MAX_DOWNLOAD_MS / 1000) + 60, aal2: actor.aal2 === true })).get(camera.id) ?? null
      const opened = sid ? await registry.open(sid, { user: actor.id, camera: camera.id, kind: 'vod', stream: null }) : null
      if (!opened?.ok) {
        if (sid) void registry.close(sid)
        await auditAccess(deps.admin, { orgId: actor.orgId, actorId: actor.id, action: 'cctv_export_denied', capability: 'cctv.export', cameraIds: [camera.id], detail: { reason: 'session' } })
        return fail(404, MSG_CAMERA_NOT_FOUND)
      }
    } catch {
      logger.error({ event: 'vod_session_failed', location: camera.code })
      if (sid) void registry.close(sid) // review m-7: made but not opened: closed again
      return fail(503, MSG_ACCESS_CHECK_FAILED)
    }
  }
  const exported = { orgId: actor.orgId, actorId: actor.id, capability: 'cctv.export' as const, cameraIds: [camera.id] }
  return deliverRecording({
    deps, actorId: actor.id, route: { camera, recorder }, startMs: query.start.getTime(), minutes: query.minutes, probe: query.probe, signal, sid, registry,
    loginPurpose: 'vod',
    audit: {
      start: () => auditAccess(deps.admin, { ...exported, action: 'cctv_export_started', detail: { minutes: query.minutes } }),
      end: () => auditAccess(deps.admin, { ...exported, action: 'cctv_export_ended' }),
    },
    headers: () => ({ 'Content-Type': 'video/mp4' }),
    pool: 'export', // review I-1: exports (cctv.export) are not paced and have no budget; they keep their own limits
  })
}

export type DeliverOptions = {
  deps: VodDeps
  actorId: string
  /** The camera and the recorder of its ACTIVE mapping (findCamera with password 'later'). */
  route: Pick<CameraRoute, 'camera' | 'recorder'>
  /** The shown-time start (ruling R13) and the length wanted. */
  startMs: number
  minutes: number
  probe: boolean
  signal?: AbortSignal
  /** The media session (already opened in the registry), or null for the probe. */
  sid: string | null
  registry: RegistryClient
  /** The purpose the NVR login is read for (P2-6, logged in vault_reads). */
  loginPurpose: 'vod' | 'playback'
  /** Audit rows: `start` when the first byte is on its way, `end` once the work is over (only after a start). */
  audit: { start: () => Promise<void>; end: () => Promise<void> }
  /** The headers of a successful answer, for the video format read from the recording list. */
  headers: (family: 'h264' | 'h265' | null) => Record<string, string>
  /** Review I-2: which conversion pool — viewers' fast playback or exports — so viewers can never block exports. */
  pool: 'fast' | 'export'
  /** Review I-1 (fast playback): the remux reads at this speed (ffmpeg -readrate), the NVR transfer is capped at `maxBytes`. */
  readrate?: number
  maxBytes?: number
  /** Review I-1 (fast playback): the paced, capped, framed body made from the remux output (lib/streams/pace.ts). */
  transform?: (body: ReadableStream<Uint8Array>) => ReadableStream<Uint8Array>
}

/**
 * The shared core of /api/vod and the fast playback stream, after the camera was allowed and its media session opened: the NVR login (read
 * only now), a place in the conversion limits (a person's own earlier conversion is ended first, waiting at most 3 seconds), the session
 * watch (re-checked every 15 s; gone or unverifiable for 45 s: the NVR transfer is aborted and the remux stopped), the NVR's recording list
 * (the first recording that covers the start, in that recorder's own clock offset), the remux adapter (asked whether it can work before the
 * NVR is asked for the download), the download, the remux. A JSON error is possible until the first byte exists; after that a failure just
 * ends the stream. Whatever happens, the slot is given back and the session closed exactly once.
 */
export async function deliverRecording(o: DeliverOptions): Promise<Response> {
  const { deps, route, registry, sid, signal } = o
  const { camera, recorder } = route
  const env = deps.env ?? process.env
  const limits = deps.conversions ?? (o.pool === 'fast' ? fastConversionLimiter() : exportConversionLimiter())
  // Review m-2: a viewer never reads configuration words (ffmpeg, FFMPEG); the export path (administrators) keeps them.
  const notSetUp = (error: string) => (o.pool === 'fast' ? MSG_FAST_NOT_SET_UP : error)
  const transfer = new AbortController() // ends everything of this request: the NVR transfer and the conversion
  let slot: Extract<ConversionSlot, { ok: true }> | null = null
  // "ended" is written only after "started", and only for a conversion that started (the process can end before this code goes on).
  const audit = { started: null as Promise<void> | null, exited: false }
  const auditEnded = () => void audit.started?.then(() => o.audit.end())

  let watch: SessionWatch | null = null
  let sessionEnded = false
  const endSession = () => {
    if (sessionEnded) return
    sessionEnded = true
    watch?.stop()
    if (sid) void registry.close(sid)
  }
  const login = await readRecorderLogin(deps, { camera, recorder, demo: false }, { purpose: o.loginPurpose, actorId: o.actorId })
  if (!login.ok) {
    endSession()
    return cameraFailure(login.error)
  }
  const password = login.password

  if (o.probe) {
    const peek = limits.peek(o.actorId, { ignoreOwn: true })
    if (!peek.ok) {
      await login.ticket?.close() // round 2 (review M-5): nothing was sent to the NVR: the claimed attempt is given back
      return fail(429, MSG_SERVER_BUSY)
    }
  } else {
    const stop = () => transfer.abort()
    let taken = limits.acquire(o.actorId, stop)
    if (!taken.ok && taken.reason === 'person') {
      // The person started something new: their earlier conversion is ended first, then this one goes ahead.
      await limits.supersede(o.actorId, deps.timing?.supersedeMs ?? SUPERSEDE_WAIT_MS)
      taken = limits.acquire(o.actorId, stop)
    }
    if (!taken.ok) {
      endSession()
      await login.ticket?.close() // round 2 (review M-5)
      logger.warn({ event: 'conversion_busy', pool: o.pool, reason: taken.reason, running: limits.running })
      return fail(429, taken.reason === 'person' ? MSG_ALREADY_RUNNING : MSG_SERVER_BUSY)
    }
    slot = taken
    if (sid) {
      watch = watchSession({
        registry, sid, everyMs: deps.timing?.validateMs ?? VOD_VALIDATE_EVERY_MS, failClosedAfterMs: deps.timing?.failClosedMs ?? VOD_FAIL_CLOSED_AFTER_MS,
        onEnd: (reason) => {
          logger.warn({ event: 'vod_session_ended', reason })
          transfer.abort() // the NVR transfer stops and the remux is told to stop (ffmpeg is killed after the grace time)
        },
      })
    }
  }

  // From here on the slot is given back by whoever ends last: this function, or the conversion once it has started.
  const forward = () => transfer.abort()
  signal?.addEventListener('abort', forward, { once: true })
  let handedOver = false
  try {
    if (signal?.aborted || transfer.signal.aborted) return new Response(null, { status: 499 })
    // The recorder's own clock offset when it has one (P2-5b), else PLAYBACK_OFFSET_MIN.
    const offset = recorderOffset(recorder, deps.offsetMin ?? parsePlaybackOffset(env.PLAYBACK_OFFSET_MIN))
    const raw = (deps.nvr ?? ((ep) => new NvrClient(ep)))({ host: recorder.host!, port: recorder.http_port, username: recorder.username, password: password! })
    // Final fix X (NB-1): every NVR request of this download settles its login ticket (a refused login starts the shared back-off).
    const client = login.ticket ? guardNvrClient(raw, login.ticket) : raw

    // Shown time (ruling R13): the NVR is asked for shown time - offset.
    const startMs = o.startMs
    let uri: string
    let family: 'h264' | 'h265' | null
    try {
      const found = await findSegments(client, { channel: camera.channel, day: new Date(startMs).toISOString().slice(0, 10), ...offset })
      const segment = found.segments.find((s) => s.start.getTime() <= startMs && startMs < s.end.getTime())
      if (!segment) return fail(404, MSG_NO_RECORDING)
      if (segment.uri === undefined) return fail(404, MSG_NOT_DOWNLOADABLE)
      const shift = clockOffsetMs(offset) ?? 0
      const to = Math.min(startMs + o.minutes * 60_000, segment.end.getTime())
      const clipped = clipPlaybackUri(segment.uri, new Date(startMs - shift), new Date(to - shift))
      if (clipped === null) return fail(404, MSG_NOT_DOWNLOADABLE) // no starttime / endtime to narrow the download: not used
      uri = clipped
      family = videoFamily(segment.codec)
    } catch (e) {
      return await nvrFailure(e, camera.code, 'vod_search_failed', deps.rls, recorder.id)
    }
    if (signal?.aborted || transfer.signal.aborted) return new Response(null, { status: 499 })

    let body: string
    try {
      body = buildDownloadBody(uri)
    } catch {
      return fail(404, MSG_NOT_DOWNLOADABLE) // an address that is not safe to pass on is not used
    }

    // Can the remux work at all? Asked before the NVR is bothered with a download that nothing could use.
    const remux = deps.remux ?? ffmpegRemux({ spawn: deps.spawn, lookup: deps.lookup, available: deps.ffmpegAvailable })
    const ready = await remux.check(env, { recorderHost: recorder.host })
    if (!ready.ok) return fail(500, notSetUp(ready.error))
    if (o.probe) return Response.json({ ok: true, codec: family }, { headers: VOD_HEADERS })

    let source: ReadableStream<Uint8Array>
    try {
      source = await client.postStream(DOWNLOAD_PATH, body, { signal: transfer.signal, maxMs: deps.timing?.transferMs ?? MAX_DOWNLOAD_MS, maxBytes: Math.min(o.maxBytes ?? MAX_DOWNLOAD_BYTES, deps.timing?.maxBytes ?? MAX_DOWNLOAD_BYTES) })
    } catch (e) {
      if (transfer.signal.aborted) return new Response(null, { status: 499 })
      return await nvrFailure(e, camera.code, 'vod_download_failed', deps.rls, recorder.id)
    }

    handedOver = true
    const converted = await remux.start({
      env,
      hevc: family === 'h265',
      readrate: o.readrate,
      source,
      abortSource: () => transfer.abort(),
      signal: transfer.signal,
      onExit: () => {
        signal?.removeEventListener('abort', forward)
        endSession()
        slot?.release()
        audit.exited = true
        auditEnded()
      },
      maxMs: deps.timing?.maxMs,
      firstByteMs: deps.timing?.firstByteMs,
      idleMs: deps.timing?.idleMs,
      killGraceMs: deps.timing?.killGraceMs,
    })
    if (!converted.ok) {
      if (converted.reason === 'missing') {
        logger.error({ event: 'vod_ffmpeg_missing', location: camera.code })
        return fail(500, notSetUp(MSG_NO_FFMPEG))
      }
      if (converted.reason === 'cancelled') return new Response(null, { status: 499 })
      if (converted.reason === 'timeout') return fail(502, await recorderMessage(deps.rls, recorder.id, describeNvrError(new NvrError('timeout', 'slow')), 'nvr_timeout'))
      if (converted.reason === 'format') return fail(502, MSG_FORMAT_UNSUPPORTED)
      return fail(502, MSG_CONVERT_FAILED)
    }
    audit.started = o.audit.start()
    if (audit.exited) auditEnded()
    await audit.started
    return new Response(o.transform ? o.transform(converted.body) : converted.body, { status: 200, headers: { ...VOD_HEADERS, ...o.headers(family) } })
  } finally {
    if (!handedOver) {
      signal?.removeEventListener('abort', forward)
      endSession()
      slot?.release()
    }
    // Round 2 (review M-5): an attempt that never reached the NVR (aborted, no remux) is given back; one that did is settled already.
    await login.ticket?.close()
  }
}

/**
 * NVR trouble as a 502 in plain words: the NVR's own words only with the IT view of the store, camera terms otherwise (fix I-2).
 * Anything unexpected is logged by its kind only: its text can carry an address or a password.
 */
async function nvrFailure(e: unknown, location: string, event: string, rls: AdminClient, recorderId: string): Promise<Response> {
  if (e instanceof NvrError) return fail(502, await recorderMessage(rls, recorderId, describeNvrError(e), `nvr_${e.kind}`))
  logger.error({ event, location, errorName: e instanceof Error ? e.name : typeof e })
  return fail(502, MSG_NVR_FAILED)
}
