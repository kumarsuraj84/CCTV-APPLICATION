import { spawn as nodeSpawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { Readable } from 'node:stream'
import type { ReadableStream as NodeWebStream } from 'node:stream/web'
import type { AdminClient, Result } from '@/lib/admin/types'
import { describeNvrError, MAX_DOWNLOAD_BYTES, MAX_DOWNLOAD_MS, NvrClient, NvrError, type NvrEndpoint } from '@/lib/nvr/client'
import { findSegments } from '@/lib/nvr/playback'
import { logger } from '@/lib/observability/logger'
import { findCamera, MSG_CAMERA_NOT_FOUND, MSG_BAD_START, MSG_NO_LOGIN, parsePlaybackOffset, startInBounds } from '@/lib/streams/playback'
import { MSG_TOO_MANY_REQUESTS, type RequestLimiter } from '@/lib/streams/request-limit'
import { parseStartIso } from '@/lib/streams/timeline'

// Fast playback (2x, 4x, 8x). The NVR sends a recording in one piece, much faster than it plays; ffmpeg rewraps it (no re-encoding) as a
// fragmented MP4, and the browser plays that with a plain <video> element at a higher speed. ffmpeg is an OPTIONAL program on the server.
//
//   browser <-- video/mp4 -- this process <-- bytes -- ffmpeg (stdin <- the NVR's download)
//
// What is trusted: nothing that comes from the NVR. Its playback address (`playbackURI`) is only ever put, escaped and capped, into the
// body of ONE request to the SAME NVR; it is never fetched, logged or sent to a browser. What the browser sends (camera, start, minutes)
// is checked before anything else happens, and the camera must be one the person may see (row-level security).

/** Longest clip. */
export const VOD_MAX_MINUTES = 30
export const VOD_MIN_MINUTES = 1
/** Running conversions: this many per person and this many in all. */
export const MAX_CONVERSIONS_PER_PERSON = 1
export const MAX_CONVERSIONS_TOTAL = 8
/** The longest a conversion runs: a little less than the longest NVR transfer, so the video ends cleanly before the transfer's own deadline cuts it. */
export const VOD_MAX_MS = MAX_DOWNLOAD_MS - 30_000
/** A conversion that has not produced its first byte after this long is given up. */
export const FIRST_BYTE_MS = 30_000
/** After asking ffmpeg to stop (SIGTERM), this long passes before it is killed outright (SIGKILL). */
export const KILL_GRACE_MS = 3_000
/** The most of ffmpeg's error output that is kept. */
export const STDERR_CAP_BYTES = 8 * 1024
/** The longest playback address that is passed on to the NVR. */
export const MAX_PLAYBACK_URI = 512
/** How long "ffmpeg works" is remembered. */
export const AVAILABILITY_TTL_MS = 60_000

export const MSG_NO_FFMPEG = 'ffmpeg is not installed on the server'
export const MSG_VOD_BAD_REQUEST = 'That request is not valid.'
export const MSG_VOD_BAD_LENGTH = `Choose how long to play, from ${VOD_MIN_MINUTES} to ${VOD_MAX_MINUTES} minutes.`
export const MSG_NO_RECORDING = 'There is no recording at that time.'
export const MSG_NOT_DOWNLOADABLE = 'This recording cannot be played at a faster speed.'
export const MSG_ALREADY_RUNNING = 'You already have a fast playback running. Stop it first, then try again.'
export const MSG_SERVER_BUSY = 'The server is busy with other fast playbacks. Try again in a moment.'
const MSG_NVR_FAILED = 'Could not read the recordings. Please try again.'
const MSG_CONVERT_FAILED = 'The recording could not be converted for fast playback.'
const DOWNLOAD_PATH = '/ISAPI/ContentMgmt/download'

// ── ffmpeg ───────────────────────────────────────────────────────────────────

/** The arguments of ffmpeg: read the recording from standard input, drop sound, copy the picture, write a fragmented MP4 to standard output. */
export function buildFfmpegArgs(): string[] {
  return ['-loglevel', 'error', '-i', 'pipe:0', '-an', '-c:v', 'copy', '-movflags', 'frag_keyframe+empty_moov+default_base_moof', '-flush_packets', '1', '-f', 'mp4', 'pipe:1']
}

let warnedFfmpeg = false
/**
 * The program to run: the FFMPEG setting (an executable name or path, set by whoever runs the server; never from a browser), `ffmpeg` when
 * it is not set. It is run directly, never through a shell. A value with a control character (a line break, NUL) or a very long one is
 * refused: null, and the first time that is reported once in the log.
 */
export function resolveFfmpeg(env: Record<string, string | undefined> = process.env): string | null {
  const raw = env.FFMPEG
  const value = raw === undefined ? '' : raw.trim()
  if (value === '') return 'ffmpeg'
  if (value.length > 1024 || /[\u0000-\u001f\u007f]/.test(value)) {
    if (!warnedFfmpeg) {
      warnedFfmpeg = true
      logger.warn({ event: 'ffmpeg_setting_invalid', note: 'FFMPEG must be the name or path of the ffmpeg program on one line; fast playback is off' })
    }
    return null
  }
  return value
}

/** ffmpeg's error output as one short line for the log: addresses and paths-with-schemes hidden, control characters and runs of space removed, at most 200 characters. */
export function sanitizeStderr(text: string): string {
  return String(text)
    .replace(/[a-z][a-z0-9+.-]*:\/\/\S*/gi, '[address]')
    .replace(/[\u0000-\u001f\u007f]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 200)
}

type Child = Pick<ChildProcessWithoutNullStreams, 'stdin' | 'stdout' | 'stderr' | 'kill' | 'on' | 'once'>
/** Starts a program with these arguments (the arguments are a list: no shell, no quoting). Tests give a different one. */
export type SpawnFn = (command: string, args: string[]) => Child
export const defaultSpawn: SpawnFn = (command, args) => nodeSpawn(command, args, { shell: false, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true })

const isMissing = (e: unknown) => ['ENOENT', 'EACCES', 'EPERM', 'EINVAL', 'ENOTDIR'].includes((e as { code?: string } | null)?.code ?? '')

export type ConversionOptions = {
  spawn?: SpawnFn
  /** The program (see resolveFfmpeg). */
  ffmpeg: string
  /** The NVR's bytes. */
  source: ReadableStream<Uint8Array>
  /** Ends the NVR transfer (called at most once per ending; safe to call again). */
  abortSource: () => void
  /** Aborted when the person goes away. */
  signal?: AbortSignal
  /** Called once, when the program is gone (or was never there): the place to give a slot back. */
  onExit?: () => void
  /** Longest total time (default VOD_MAX_MS, 29.5 minutes), time to the first byte (30 s) and wait before the kill (3 s). */
  maxMs?: number
  firstByteMs?: number
  killGraceMs?: number
}
export type ConversionResult = { ok: true; body: ReadableStream<Uint8Array> } | { ok: false; reason: 'missing' | 'failed' | 'timeout' | 'cancelled' }

/**
 * Pipes `source` through ffmpeg and gives back its output as a stream, once the FIRST BYTE of output exists (so a failure before that is
 * still an error the caller can answer in JSON). After that the stream ends with an error if ffmpeg fails.
 *
 * The pace is the reader's: output is read from ffmpeg only while the reader keeps up, which stops ffmpeg, which stops the pipe, which
 * stops the download. Nothing is buffered beyond a few chunks. Whenever the stream is cancelled (the person closes the page), the
 * `signal` aborts, the total time runs out, the NVR transfer fails or ffmpeg ends, then: the NVR transfer is aborted, ffmpeg's input
 * is closed and ffmpeg is told to stop (SIGTERM), and killed (SIGKILL) if it is still there after the grace time. `onExit` runs once the
 * program is really gone, so a slot is never given back while a process is still running.
 */
export function startConversion(o: ConversionOptions): Promise<ConversionResult> {
  const grace = o.killGraceMs ?? KILL_GRACE_MS
  return new Promise<ConversionResult>((resolve) => {
    let child: Child
    try {
      child = (o.spawn ?? defaultSpawn)(o.ffmpeg, buildFfmpegArgs())
    } catch (e) {
      o.abortSource()
      o.onExit?.()
      resolve({ ok: false, reason: isMissing(e) ? 'missing' : 'failed' })
      return
    }

    let started = false // the first byte of output has been passed on: the answer is on its way
    let done = false // the ending has begun (only one ending ever runs)
    let exited = false
    let spawned = false
    let stderr = ''
    let killTimer: ReturnType<typeof setTimeout> | undefined
    let controller: ReadableStreamDefaultController<Uint8Array> | undefined

    const source = Readable.fromWeb(o.source as unknown as NodeWebStream<Uint8Array>)

    const exitOnce = () => {
      if (exited) return
      exited = true
      clearTimeout(killTimer)
      o.onExit?.()
    }
    // Everything that is not the output stream itself. Safe to run more than once.
    const stop = () => {
      clearTimeout(startTimer)
      clearTimeout(totalTimer)
      o.signal?.removeEventListener('abort', onAbort)
      o.abortSource()
      source.unpipe()
      source.destroy()
      child.stdin.destroy()
      if (!exited) {
        try {
          child.kill('SIGTERM')
        } catch {
          // already gone
        }
        killTimer = setTimeout(() => {
          if (exited) return
          try {
            child.kill('SIGKILL')
          } catch {
            // already gone
          }
        }, grace)
        killTimer.unref?.()
      }
    }
    // Ends the conversion. `how` is what the output stream does: nothing (the reader has gone), an end, or an error.
    const end = (how: 'quiet' | 'close' | 'error', reason: Extract<ConversionResult, { ok: false }>['reason']) => {
      if (done) return
      done = true
      stop()
      if (!started) {
        resolve({ ok: false, reason })
        return
      }
      try {
        if (how === 'close') controller?.close()
        else if (how === 'error') controller?.error(new Error('The conversion stopped.'))
      } catch {
        // the reader has already gone
      }
    }
    function onAbort() {
      end('error', 'cancelled')
    }

    const output = new ReadableStream<Uint8Array>(
      {
        start(c) {
          controller = c
        },
        pull() {
          child.stdout.resume()
        },
        cancel() {
          end('quiet', 'cancelled')
        },
      },
      { highWaterMark: 4 },
    )

    child.stdin.on('error', () => {}) // ffmpeg stopped reading: the end of the process says why
    child.stdout.on('error', () => end('error', 'failed'))
    child.stderr.on('error', () => {})
    child.stderr.on('data', (chunk: Buffer) => {
      if (stderr.length < STDERR_CAP_BYTES) stderr += chunk.toString('utf8').slice(0, STDERR_CAP_BYTES - stderr.length)
    })
    child.once('spawn', () => {
      spawned = true
    })
    child.on('error', (e) => {
      // The program could not be started (or, rarely, not be stopped).
      if (!spawned) {
        exitOnce()
        end('error', isMissing(e) ? 'missing' : 'failed')
      }
    })
    child.on('close', (code: number | null, signal: NodeJS.Signals | null) => {
      exitOnce()
      if (done) return
      // ffmpeg ended by itself: everything it wrote has been passed on already.
      if (code !== 0 || (!started && signal === null)) logger.warn({ event: 'vod_ffmpeg_ended', exitCode: code, signal, line: sanitizeStderr(stderr) })
      end(code === 0 && started ? 'close' : 'error', 'failed')
    })
    child.stdout.on('data', (chunk: Buffer) => {
      if (done) return
      if (!started) {
        started = true
        clearTimeout(startTimer)
        resolve({ ok: true, body: output })
      }
      try {
        controller!.enqueue(chunk)
      } catch {
        return
      }
      if ((controller!.desiredSize ?? 0) <= 0) child.stdout.pause()
    })

    source.on('error', () => end('error', 'failed'))
    source.pipe(child.stdin)

    // (These run only after the lines below have set them; `stop` reads them when it runs, not when it is written.)
    const startTimer = setTimeout(() => end('error', 'timeout'), o.firstByteMs ?? FIRST_BYTE_MS)
    // The longest total time: the picture just ends (a clip is never longer than this).
    const totalTimer = setTimeout(() => end('close', 'timeout'), o.maxMs ?? VOD_MAX_MS)
    if (o.signal?.aborted) onAbort()
    else o.signal?.addEventListener('abort', onAbort, { once: true })
  })
}

// ── is ffmpeg there? ─────────────────────────────────────────────────────────

/**
 * A check that the program runs (`ffmpeg -version` ends with 0 within a few seconds). The answer is remembered for a minute per program,
 * and a check that is already running is shared. Used to decide what the Playback screen offers.
 */
export function createFfmpegCheck(o: { spawn?: SpawnFn; now?: () => number; ttlMs?: number; timeoutMs?: number } = {}) {
  const run = o.spawn ?? defaultSpawn
  const now = o.now ?? Date.now
  const ttl = o.ttlMs ?? AVAILABILITY_TTL_MS
  const timeout = o.timeoutMs ?? 5_000
  const known = new Map<string, { at: number; ok: boolean }>()
  const running = new Map<string, Promise<boolean>>()
  const probe = (exe: string) =>
    new Promise<boolean>((resolve) => {
      let child: Child
      try {
        child = run(exe, ['-version'])
      } catch {
        resolve(false)
        return
      }
      const timer = setTimeout(() => finish(false), timeout)
      timer.unref?.()
      function finish(ok: boolean) {
        clearTimeout(timer)
        if (!ok) {
          try {
            child.kill('SIGKILL')
          } catch {
            // already gone
          }
        }
        resolve(ok)
      }
      for (const s of [child.stdout, child.stderr]) {
        s.on('error', () => {})
        s.resume()
      }
      child.stdin.on('error', () => {})
      child.stdin.end()
      child.once('error', () => finish(false))
      child.once('close', (code: number | null) => finish(code === 0))
    })
  return async function available(env: Record<string, string | undefined> = process.env): Promise<boolean> {
    const exe = resolveFfmpeg(env)
    if (exe === null) return false
    const hit = known.get(exe)
    if (hit && now() - hit.at < ttl) return hit.ok
    let p = running.get(exe)
    if (!p) {
      p = probe(exe).then((ok) => {
        if (known.size >= 8) known.clear()
        known.set(exe, { at: now(), ok })
        running.delete(exe)
        return ok
      })
      running.set(exe, p)
    }
    return p
  }
}

/** Whether fast playback can work on this server (ffmpeg runs), remembered for a minute. */
export const fastPlaybackAvailable = createFfmpegCheck()

// ── limits ───────────────────────────────────────────────────────────────────

export type ConversionSlot = { ok: true; release: () => void } | { ok: false; reason: 'person' | 'total' }
export type ConversionLimiter = {
  /** Takes a place for this person (the caller must `release` it exactly when the work is over; releasing twice does nothing). */
  acquire(key: string): ConversionSlot
  /** Would a place be given, without taking it. */
  peek(key: string): { ok: true } | { ok: false; reason: 'person' | 'total' }
  readonly running: number
}

/** Counts running conversions: `perPerson` for each person and `total` in all. In this process only. */
export function createConversionLimiter(perPerson = MAX_CONVERSIONS_PER_PERSON, total = MAX_CONVERSIONS_TOTAL): ConversionLimiter {
  const byPerson = new Map<string, number>()
  let sum = 0
  const refusal = (key: string): 'person' | 'total' | null => ((byPerson.get(key) ?? 0) >= perPerson ? 'person' : sum >= total ? 'total' : null)
  return {
    acquire(key) {
      const why = refusal(key)
      if (why) return { ok: false, reason: why }
      byPerson.set(key, (byPerson.get(key) ?? 0) + 1)
      sum++
      let released = false
      return {
        ok: true,
        release() {
          if (released) return
          released = true
          sum--
          const left = (byPerson.get(key) ?? 1) - 1
          if (left <= 0) byPerson.delete(key)
          else byPerson.set(key, left)
        },
      }
    },
    peek(key) {
      const why = refusal(key)
      return why ? { ok: false, reason: why } : { ok: true }
    },
    get running() {
      return sum
    },
  }
}

/** The conversions running in this process. */
export const conversionLimiter: ConversionLimiter = createConversionLimiter()

// ── the NVR's playback address ───────────────────────────────────────────────

const URI = /^(?:rtsp|https?):\/\/[^\s\u0000-\u001f\u007f]+$/i
const escapeXml = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`)
const two = (n: number) => String(n).padStart(2, '0')

/** An NVR instant as the NVR writes it in a playback address: `yyyymmddThhmmssZ`. */
function nvrStamp(d: Date): string {
  return `${String(d.getUTCFullYear()).padStart(4, '0')}${two(d.getUTCMonth() + 1)}${two(d.getUTCDate())}T${two(d.getUTCHours())}${two(d.getUTCMinutes())}${two(d.getUTCSeconds())}Z`
}

/**
 * The NVR's playback address with its `starttime` and `endtime` replaced by `from` and `to` (NVR instants), so that only the part wanted
 * is downloaded, not the whole recording file. An address without both is returned as it is. The replacement values are made here;
 * nothing else of the address is read or changed.
 */
export function clipPlaybackUri(uri: string, from: Date, to: Date): string {
  if (!/[?&]starttime=/i.test(uri) || !/[?&]endtime=/i.test(uri)) return uri
  return uri.replace(/([?&]starttime=)[^&]*/i, (_m, head: string) => head + nvrStamp(from)).replace(/([?&]endtime=)[^&]*/i, (_m, head: string) => head + nvrStamp(to))
}

/**
 * The body of the download request. The playback address came from the NVR, so it is treated as hostile: it must be an rtsp, http or
 * https address of at most 512 characters with no space or control character, and it is escaped. It goes nowhere but this body.
 * Anything else is a plain Error that does not echo the address.
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
  /** The shared count of video requests per person. */
  limiter?: RequestLimiter
  conversions?: ConversionLimiter
  nvr?: (ep: NvrEndpoint) => NvrClient
  spawn?: SpawnFn
  /** Settings (default process.env): FFMPEG and PLAYBACK_OFFSET_MIN. */
  env?: Record<string, string | undefined>
  /** Milliseconds since the epoch (default Date.now). */
  now?: () => number
  /** Minutes to take off a shown time to get the NVR's time (default: PLAYBACK_OFFSET_MIN from `env`). */
  offsetMin?: number
  /** Whether ffmpeg runs: asked before the NVR is asked for the download, and by `probe=1`. Default: the shared check, remembered for a minute (without it when `spawn` is given, where a start that fails is answered the same way). */
  ffmpegAvailable?: (env: Record<string, string | undefined>) => Promise<boolean>
  /** Test settings. */
  timing?: { maxMs?: number; transferMs?: number; firstByteMs?: number; killGraceMs?: number; maxBytes?: number }
}

const HEADERS = { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' }
const fail = (status: number, error: string) => Response.json({ error }, { status, headers: HEADERS })

function cameraFailure(error: string): Response {
  if (error === MSG_CAMERA_NOT_FOUND) return fail(404, error)
  if (error === MSG_NO_LOGIN) return fail(409, error)
  return fail(500, error)
}

/**
 * The answer to GET /api/vod for a signed-in person (the route has already checked who they are). Either a JSON error with a plain
 * message, or `video/mp4` that is streamed while it is made. `signal` is the request's own: it aborts when the person goes away.
 *
 * Order: the input is checked; the person's count of video requests; the camera (row-level security: a camera they may not see is
 * the same "not found" as one that does not exist); the NVR password (service-role call, only for a visible camera); a place in the
 * conversion limits; the NVR's recording list (the first recording that covers the start); then ffmpeg and the download. A JSON error
 * is possible until the first byte of video exists; after that a failure just ends the video.
 *
 * `probe=1` does everything except start ffmpeg and the download, and answers `{ ok: true }` or the same JSON error: the Playback
 * screen uses it to find out why a video did not play, because a <video> element cannot read the reason.
 */
export async function serveVod(deps: VodDeps, actor: { id: string }, query: VodQuery, signal?: AbortSignal): Promise<Response> {
  const env = deps.env ?? process.env
  const now = deps.now ?? Date.now
  if (!startInBounds(query.start.getTime(), now())) return fail(400, MSG_BAD_START)
  if (deps.limiter && !deps.limiter.allow(actor.id)) return fail(429, MSG_TOO_MANY_REQUESTS)

  const c = await findCamera(deps, query.camera, { password: 'always' })
  if (!c.ok) return cameraFailure(c.error)
  const { camera, password } = c
  const store = camera.stores
  if (signal?.aborted) return new Response(null, { status: 499 })

  const limits = deps.conversions ?? conversionLimiter
  let slot: Extract<ConversionSlot, { ok: true }> | null = null
  if (query.probe) {
    const peek = limits.peek(actor.id)
    if (!peek.ok) return fail(429, peek.reason === 'person' ? MSG_ALREADY_RUNNING : MSG_SERVER_BUSY)
  } else {
    const taken = limits.acquire(actor.id)
    if (!taken.ok) return fail(429, taken.reason === 'person' ? MSG_ALREADY_RUNNING : MSG_SERVER_BUSY)
    slot = taken
  }

  // From here on the slot is given back by whoever ends last: this function, or the conversion once it has started.
  const transfer = new AbortController()
  const forward = () => transfer.abort()
  signal?.addEventListener('abort', forward, { once: true })
  let handedOver = false
  try {
    const offsetMin = deps.offsetMin ?? parsePlaybackOffset(env.PLAYBACK_OFFSET_MIN)
    const client = (deps.nvr ?? ((ep) => new NvrClient(ep)))({ host: store.nvr_ip, port: store.http_port, username: store.nvr_username, password: password! })

    // Shown time (ruling R13): the NVR is asked for shown time - offset.
    const startMs = query.start.getTime()
    let uri: string | undefined
    try {
      const found = await findSegments(client, { channel: camera.channel, day: query.start.toISOString().slice(0, 10), offsetMin })
      const segment = found.segments.find((s) => s.start.getTime() <= startMs && startMs < s.end.getTime())
      if (!segment) return fail(404, MSG_NO_RECORDING)
      if (segment.uri === undefined) return fail(404, MSG_NOT_DOWNLOADABLE)
      const shift = offsetMin * 60_000
      const to = Math.min(startMs + query.minutes * 60_000, segment.end.getTime())
      uri = clipPlaybackUri(segment.uri, new Date(startMs - shift), new Date(to - shift))
    } catch (e) {
      return nvrFailure(e, store.code, 'vod_search_failed')
    }
    if (signal?.aborted) return new Response(null, { status: 499 })

    let body: string
    try {
      body = buildDownloadBody(uri)
    } catch {
      return fail(404, MSG_NOT_DOWNLOADABLE) // an address that is not safe to pass on is not used
    }

    // Is there an ffmpeg at all? Asked before the NVR is bothered with a download that nothing could use.
    const ffmpeg = resolveFfmpeg(env)
    const available = deps.ffmpegAvailable ?? (deps.spawn ? async () => true : (e: Record<string, string | undefined>) => fastPlaybackAvailable(e))
    if (ffmpeg === null || !(await available(env))) return fail(500, MSG_NO_FFMPEG)
    if (query.probe) return Response.json({ ok: true }, { headers: HEADERS })

    let source: ReadableStream<Uint8Array>
    try {
      source = await client.postStream(DOWNLOAD_PATH, body, { signal: transfer.signal, maxMs: deps.timing?.transferMs ?? MAX_DOWNLOAD_MS, maxBytes: deps.timing?.maxBytes ?? MAX_DOWNLOAD_BYTES })
    } catch (e) {
      return nvrFailure(e, store.code, 'vod_download_failed')
    }

    handedOver = true
    const converted = await startConversion({
      spawn: deps.spawn,
      ffmpeg,
      source,
      abortSource: () => transfer.abort(),
      signal: transfer.signal,
      onExit: () => {
        signal?.removeEventListener('abort', forward)
        slot?.release()
      },
      maxMs: deps.timing?.maxMs,
      firstByteMs: deps.timing?.firstByteMs,
      killGraceMs: deps.timing?.killGraceMs,
    })
    if (!converted.ok) {
      if (converted.reason === 'missing') {
        logger.error({ event: 'vod_ffmpeg_missing', store: store.code })
        return fail(500, MSG_NO_FFMPEG)
      }
      if (converted.reason === 'cancelled') return new Response(null, { status: 499 })
      if (converted.reason === 'timeout') return fail(502, describeNvrError(new NvrError('timeout', 'slow')))
      return fail(502, MSG_CONVERT_FAILED)
    }
    return new Response(converted.body, { status: 200, headers: { ...HEADERS, 'Content-Type': 'video/mp4' } })
  } finally {
    if (!handedOver) {
      signal?.removeEventListener('abort', forward)
      slot?.release()
    }
  }
}

/** NVR trouble as a 502 in plain words. Anything unexpected is logged by its kind only: its text can carry an address or a password. */
function nvrFailure(e: unknown, store: string, event: string): Response {
  if (e instanceof NvrError) return fail(502, describeNvrError(e))
  logger.error({ event, store, errorName: e instanceof Error ? e.name : typeof e })
  return fail(502, MSG_NVR_FAILED)
}
