import { spawn as nodeSpawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { accessSync, constants, statSync } from 'node:fs'
import path from 'node:path'
import { Readable } from 'node:stream'
import type { ReadableStream as NodeWebStream } from 'node:stream/web'
import type { AdminClient, Result } from '@/lib/admin/types'
import { auditAccess } from '@/lib/auth/access-audit'
import { MSG_ACCESS_CHECK_FAILED } from '@/lib/auth/resource'
import { MSG_MONITORING_OFF, MSG_NOT_MAPPED } from '@/lib/inventory/recorders'
import { describeNvrError, MAX_DOWNLOAD_BYTES, MAX_DOWNLOAD_MS, NvrClient, NvrError, type NvrEndpoint } from '@/lib/nvr/client'
import { clockOffsetMs, findSegments } from '@/lib/nvr/playback'
import { logger } from '@/lib/observability/logger'
import { processSingleton } from '@/lib/process-singleton'
import { findCamera, readRecorderLogin, MSG_CAMERA_NOT_FOUND, MSG_BAD_START, MSG_NO_LOGIN, MSG_RECORDINGS_UNREACHABLE, parsePlaybackOffset, recorderMessage, recorderOffset, startInBounds } from '@/lib/streams/playback'
import { adminRegistry, createMediaSessions, type RegistryClient } from '@/lib/streams/registry'
import { MSG_TOO_MANY_REQUESTS, type RequestLimiter } from '@/lib/streams/request-limit'
import { watchSession, type SessionWatch } from '@/lib/streams/session-watch'
import { parseStartIso } from '@/lib/streams/timeline'

// Fast playback (2x, 4x, 8x). The NVR sends a recording in one piece, much faster than it plays; ffmpeg rewraps it (no re-encoding) as a
// fragmented MP4, and the browser plays that with a plain <video> element at a higher speed. ffmpeg is an OPTIONAL program on the server.
//
//   browser <-- video/mp4 -- this process <-- bytes -- ffmpeg (stdin <- the NVR's download)
//
// What is trusted: nothing that comes from the NVR. Its playback address (`playbackURI`) is only ever put, escaped and capped, into the
// body of ONE request to the SAME NVR; it is never fetched, logged or sent to a browser. What the browser sends (camera, start, minutes)
// is checked before anything else happens, and the camera must be one the person may export (cctv.export, checked by the database).

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
/** A conversion ends when the NVR has sent nothing for this long while it was being waited for (not while the viewer is slow). */
export const SOURCE_IDLE_MS = 60_000
/** A person's new conversion waits at most this long for their previous one to end. */
export const SUPERSEDE_WAIT_MS = 3_000
/** How long "ffmpeg works" is remembered. */
export const AVAILABILITY_TTL_MS = 60_000

export const MSG_NO_FFMPEG = 'ffmpeg is not installed on the server'
export const MSG_VOD_BAD_REQUEST = 'That request is not valid.'
export const MSG_VOD_BAD_LENGTH = `Choose how long to play, from ${VOD_MIN_MINUTES} to ${VOD_MAX_MINUTES} minutes.`
export const MSG_NO_RECORDING = 'There is no recording at that time.'
export const MSG_NOT_DOWNLOADABLE = 'This recording cannot be played at a faster speed.'
export const MSG_ALREADY_RUNNING = 'You already have a fast playback running. Stop it first, then try again.'
export const MSG_SERVER_BUSY = 'The server is busy with other fast playbacks. Try again in a moment.'
export const MSG_FFMPEG_PATH = 'FFMPEG must be the full path of the ffmpeg program.'
export const MSG_FORMAT_UNSUPPORTED = "This recording's format is not supported for fast playback."
const MSG_NVR_FAILED = 'Could not read the recordings. Please try again.'
const MSG_CONVERT_FAILED = 'The recording could not be converted for fast playback.'
const DOWNLOAD_PATH = '/ISAPI/ContentMgmt/download'

// ── ffmpeg ───────────────────────────────────────────────────────────────────

/**
 * The input formats ffmpeg is allowed to recognise (`-format_whitelist`, demuxer names). Hikvision NVRs send a download as MPEG program
 * stream ("mpeg": the usual one), MPEG transport stream ("mpegts"), MP4 ("mov" is ffmpeg's name for the mov/mp4 reader) or, on some
 * firmware, a bare H.264 / H.265 stream ("h264", "hevc"). Anything else, such as a playlist or a container that can name other files,
 * is refused instead of being probed. This is the list that is believed right for those NVRs; if a real NVR sends something else the
 * answer is "This recording's format is not supported for fast playback." and the list is the place to add it.
 */
export const FORMAT_WHITELIST = 'mpeg,mpegts,mov,mp4,h264,hevc'

/**
 * The arguments of ffmpeg: no keyboard reading, only errors reported, only the `pipe` protocol (so no input can make it open a file or
 * a network address) and only the formats of FORMAT_WHITELIST (both are input options, so they come before `-i`), read the recording from
 * standard input, drop sound, copy the picture (tagged `hvc1` when it is H.265, which is what browsers expect), write a fragmented MP4 to
 * standard output. `-xerror` is left out on purpose: a recording with one damaged frame should still play.
 */
export function buildFfmpegArgs(o: { hevc?: boolean } = {}): string[] {
  return [
    '-nostdin',
    '-loglevel', 'error',
    '-protocol_whitelist', 'pipe',
    '-format_whitelist', FORMAT_WHITELIST,
    '-i', 'pipe:0',
    '-an',
    '-c:v', 'copy',
    ...(o.hevc ? ['-tag:v', 'hvc1'] : []),
    '-movflags', 'frag_keyframe+empty_moov+default_base_moof',
    '-flush_packets', '1',
    '-f', 'mp4',
    'pipe:1',
  ]
}

/** The family of a video format name as an NVR writes it ("H.264-BP", "H.265", "HEVC"), or null when it is not one of these. */
export function videoFamily(name: string | undefined): 'h264' | 'h265' | null {
  if (name === undefined) return null
  if (/265|hevc/i.test(name)) return 'h265'
  if (/264|avc/i.test(name)) return 'h264'
  return null
}

let warnedFfmpeg = false
const CONTROL = /[\u0000-\u001f\u007f]/
export type FfmpegProgram = { ok: true; path: string } | { ok: false; error: string }
export type ProgramLookup = {
  /** Is there a runnable file at this path? (default: the real file system) */
  exists?: (file: string) => boolean
  /** Which system's path rules apply (default: this one). */
  platform?: NodeJS.Platform
}

function isRunnableFile(file: string): boolean {
  try {
    if (!statSync(file).isFile()) return false
    if (process.platform !== 'win32') accessSync(file, constants.X_OK)
    return true
  } catch {
    return false
  }
}

/** A full path: a drive letter or a share on Windows, a leading / elsewhere. Not relative, not "rooted on the current drive". */
function isFullPath(value: string, platform: NodeJS.Platform): boolean {
  if (platform === 'win32') return path.win32.isAbsolute(value) && /^(?:[A-Za-z]:[\\/]|\\\\[^\\/])/.test(value)
  return path.posix.isAbsolute(value)
}

/**
 * The program to run. The FFMPEG setting (set by whoever runs the server; never from a browser) must be a FULL path on one line; anything
 * else is refused with a plain message, so a program is never found through the current folder or a relative search path. When it is not
 * set, `ffmpeg` (`ffmpeg.exe` on Windows) is looked for in the full-path entries of PATH only: empty entries, "." and relative entries are
 * skipped. The program is then run directly, never through a shell.
 */
export function resolveFfmpeg(env: Record<string, string | undefined> = process.env, lookup: ProgramLookup = {}): FfmpegProgram {
  const platform = lookup.platform ?? process.platform
  const value = (env.FFMPEG ?? '').trim()
  if (value !== '') {
    if (value.length <= 1024 && !CONTROL.test(value) && isFullPath(value, platform)) return { ok: true, path: value }
    if (!warnedFfmpeg) {
      warnedFfmpeg = true
      logger.warn({ event: 'ffmpeg_setting_invalid', note: 'FFMPEG must be the full path of the ffmpeg program on one line; fast playback is off' })
    }
    return { ok: false, error: MSG_FFMPEG_PATH }
  }
  const exists = lookup.exists ?? isRunnableFile
  const pathKey = Object.keys(env).find((k) => k.toUpperCase() === 'PATH')
  const list = pathKey === undefined ? '' : (env[pathKey] ?? '')
  const win = platform === 'win32'
  for (const entry of list.split(win ? ';' : ':')) {
    const dir = entry.trim().replace(/^"(.*)"$/, '$1')
    if (dir === '' || dir.length > 1024 || CONTROL.test(dir) || !isFullPath(dir, platform)) continue
    const file = (win ? path.win32 : path.posix).join(dir, win ? 'ffmpeg.exe' : 'ffmpeg')
    if (exists(file)) return { ok: true, path: file }
  }
  return { ok: false, error: MSG_NO_FFMPEG }
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
/** A SpawnFn on top of child_process.spawn (or a stand-in): never through a shell, three pipes, no console window. */
export const createSpawn =
  (impl: typeof nodeSpawn = nodeSpawn): SpawnFn =>
  (command, args) =>
    impl(command, args, { shell: false, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true })
export const defaultSpawn: SpawnFn = createSpawn()

const isMissing = (e: unknown) => ['ENOENT', 'EACCES', 'EPERM', 'EINVAL', 'ENOTDIR'].includes((e as { code?: string } | null)?.code ?? '')

export type ConversionOptions = {
  spawn?: SpawnFn
  /** The program (see resolveFfmpeg). */
  ffmpeg: string
  /** The recording is H.265: the picture is tagged `hvc1`. */
  hevc?: boolean
  /** The NVR's bytes. */
  source: ReadableStream<Uint8Array>
  /** Ends the NVR transfer (called at most once per ending; safe to call again). */
  abortSource: () => void
  /** Aborted when the person goes away. */
  signal?: AbortSignal
  /** Called once, when the program is gone (or was never there): the place to give a slot back. */
  onExit?: () => void
  /** Longest total time (default VOD_MAX_MS, 29.5 minutes), time to the first byte (30 s), time without NVR data (60 s) and wait before the kill (3 s). */
  maxMs?: number
  firstByteMs?: number
  idleMs?: number
  killGraceMs?: number
  /** Makes the node stream that is piped into ffmpeg (default `Readable.fromWeb`). Tests give one that fails. */
  toNodeStream?: (source: ReadableStream<Uint8Array>) => Readable
}
export type ConversionFailure = 'missing' | 'failed' | 'format' | 'timeout' | 'cancelled'
export type ConversionResult = { ok: true; body: ReadableStream<Uint8Array> } | { ok: false; reason: ConversionFailure }

const FORMAT_PROBLEM =
  /unsupported codec|invalid data found|whitelist|could not find codec parameters|moov atom not found|(?:unknown|no) (?:decoder|encoder)|codec not currently supported|unsupported (?:pixel format|profile)/i

/** 'format' when ffmpeg's last words say it did not understand the recording (or the format is not on the whitelist), else 'failed'. */
export function classifyFfmpegFailure(stderr: string): 'format' | 'failed' {
  return FORMAT_PROBLEM.test(stderr) ? 'format' : 'failed'
}

const nodeStreamOf = (source: ReadableStream<Uint8Array>): Readable => Readable.fromWeb(source as unknown as NodeWebStream<Uint8Array>)

/**
 * Pipes `source` through ffmpeg and gives back its output as a stream, once the FIRST BYTE of output exists (so a failure before that is
 * still an error the caller can answer in JSON). After that the stream ends with an error if ffmpeg fails.
 *
 * The pace is the reader's: output is read from ffmpeg only while the reader keeps up, which stops ffmpeg, which stops the pipe, which
 * stops the download. Nothing is buffered beyond a few chunks. Whenever the stream is cancelled (the person closes the page), the
 * `signal` aborts, the total time runs out, the NVR sends nothing for `idleMs` (the clock only runs while the NVR is being waited for, not
 * while the viewer is slow), the NVR transfer fails or ffmpeg ends, then: the NVR transfer is aborted, ffmpeg's input is closed and
 * ffmpeg is told to stop (SIGTERM), and killed (SIGKILL) if it is still there after the grace time. `onExit` runs once the program is
 * really gone, so a slot is never given back while a process is still running. If anything in the set-up after the program was started
 * throws, that is an ending too (`failed`), so the program is stopped and the slot is given back.
 */
export function startConversion(o: ConversionOptions): Promise<ConversionResult> {
  const grace = o.killGraceMs ?? KILL_GRACE_MS
  const idleMs = o.idleMs ?? SOURCE_IDLE_MS
  return new Promise<ConversionResult>((resolve) => {
    let child: Child
    try {
      child = (o.spawn ?? defaultSpawn)(o.ffmpeg, buildFfmpegArgs({ hevc: o.hevc }))
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
    let startTimer: ReturnType<typeof setTimeout> | undefined
    let totalTimer: ReturnType<typeof setTimeout> | undefined
    let idleTimer: ReturnType<typeof setTimeout> | undefined
    let controller: ReadableStreamDefaultController<Uint8Array> | undefined
    let output: ReadableStream<Uint8Array> | undefined
    let source: Readable | undefined

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
      clearTimeout(idleTimer)
      o.signal?.removeEventListener('abort', onAbort)
      o.abortSource()
      if (source) {
        source.unpipe()
        source.destroy()
      }
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
    const end = (how: 'quiet' | 'close' | 'error', reason: ConversionFailure) => {
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

    // The program's side first, so that whatever goes wrong in the rest of the set-up still sees it end.
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
      end(code === 0 && started ? 'close' : 'error', !started ? classifyFfmpegFailure(stderr) : 'failed')
    })
    child.stdout.on('data', (chunk: Buffer) => {
      if (done || !output || !controller) return
      if (!started) {
        started = true
        clearTimeout(startTimer)
        resolve({ ok: true, body: output })
      }
      try {
        controller.enqueue(chunk)
      } catch {
        return
      }
      if ((controller.desiredSize ?? 0) <= 0) child.stdout.pause()
    })

    try {
      output = new ReadableStream<Uint8Array>(
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

      source = (o.toNodeStream ?? nodeStreamOf)(o.source)
      // The NVR is "being waited for" while the stream flows; when ffmpeg is slow to take the bytes (or the viewer is slow to take
      // ffmpeg's) the pipe pauses the stream and the clock stops.
      const armIdle = () => {
        clearTimeout(idleTimer)
        idleTimer = setTimeout(() => end('error', 'timeout'), idleMs)
      }
      source.on('error', () => end('error', 'failed'))
      source.on('data', armIdle)
      source.on('resume', armIdle)
      source.on('pause', () => clearTimeout(idleTimer))
      source.on('end', () => clearTimeout(idleTimer))
      source.pipe(child.stdin)

      startTimer = setTimeout(() => end('error', 'timeout'), o.firstByteMs ?? FIRST_BYTE_MS)
      // The longest total time: the picture just ends (a clip is never longer than this).
      totalTimer = setTimeout(() => end('close', 'timeout'), o.maxMs ?? VOD_MAX_MS)
      armIdle()
      if (o.signal?.aborted) onAbort()
      else o.signal?.addEventListener('abort', onAbort, { once: true })
    } catch {
      end('error', 'failed')
    }
  })
}

// ── is ffmpeg there? ─────────────────────────────────────────────────────────

/**
 * A check that the program runs (`ffmpeg -version` ends with 0 within a few seconds). The answer is remembered for a minute per program,
 * and a check that is already running is shared. Used to decide what the Playback screen offers.
 */
export function createFfmpegCheck(o: { spawn?: SpawnFn; now?: () => number; ttlMs?: number; timeoutMs?: number; lookup?: ProgramLookup } = {}) {
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
    const found = resolveFfmpeg(env, o.lookup)
    if (!found.ok) return false
    const exe = found.path
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
export const fastPlaybackAvailable = processSingleton('cctv.fastPlaybackAvailable', () => createFfmpegCheck())

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

/** The conversions running in this process: one count for route handlers, actions and reloaded modules alike. */
export const conversionLimiter: ConversionLimiter = processSingleton('cctv.conversionLimiter', () => createConversionLimiter())

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
  timing?: { maxMs?: number; transferMs?: number; firstByteMs?: number; idleMs?: number; killGraceMs?: number; maxBytes?: number; supersedeMs?: number; validateMs?: number; failClosedMs?: number }
}

/** P2-4 (D-3): how often a running download's media session is re-checked, and how long without an answer before it is cut. */
export const VOD_VALIDATE_EVERY_MS = 15_000
export const VOD_FAIL_CLOSED_AFTER_MS = 45_000

const HEADERS = { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Cross-Origin-Resource-Policy': 'same-origin' }
const fail = (status: number, error: string) => Response.json({ error }, { status, headers: HEADERS })

function cameraFailure(error: string): Response {
  if (error === MSG_CAMERA_NOT_FOUND) return fail(404, error)
  if (error === MSG_NO_LOGIN) return fail(409, error)
  if (error === MSG_RECORDINGS_UNREACHABLE) return fail(502, error) // camera terms: no status that tells login trouble apart (fix I-2)
  if (error === MSG_MONITORING_OFF) return fail(409, error) // owner addition: the NVR is switched off, nothing was contacted
  if (error === MSG_NOT_MAPPED) return fail(409, error) // P2-5b: the camera has no active mapping, so there is no NVR to ask
  return fail(500, error)
}

/**
 * The answer to GET /api/vod for a signed-in person (the route has already checked who they are). Either a JSON error with a plain
 * message, or `video/mp4` that is streamed while it is made. `signal` is the request's own: it aborts when the person goes away.
 *
 * Order: the input is checked; the person's count of video requests; the camera (cctv.export for it, checked by the database as the
 * person: a camera they may not export is the same "not found" as one that does not exist); the NVR address and password (service-role
 * calls, only for a camera that passed); a place in the
 * conversion limits (a person's own earlier conversion is ended first, waiting at most 3 seconds, so starting a new one never fails
 * because of the old one); the NVR's recording list (the first recording that covers the start); then ffmpeg and the download. A JSON
 * error is possible until the first byte of video exists; after that a failure just ends the video.
 *
 * `probe=1` does everything except start ffmpeg and the download, and answers `{ ok: true, codec }` (codec: 'h264', 'h265' or null)
 * or the same JSON error: the Playback screen uses it to find out why a video did not play, because a <video> element cannot read the
 * reason. It takes no place and ignores the person's own running conversion.
 */
export async function serveVod(deps: VodDeps, actor: { id: string; orgId: string }, query: VodQuery, signal?: AbortSignal): Promise<Response> {
  const env = deps.env ?? process.env
  const now = deps.now ?? Date.now
  if (!startInBounds(query.start.getTime(), now())) return fail(400, MSG_BAD_START)
  if (deps.limiter && !deps.limiter.allow(actor.id)) return fail(429, MSG_TOO_MANY_REQUESTS)

  // Fast playback hands over a savable MP4 of a recording, so it needs cctv.export AND cctv.playback for the camera (decision D-6a;
  // P2-2 fix M-3: export alone gets the same refusal as no right at all).
  // P2-4 review m-6: the NVR login is read only after the download's media session exists (fail closed before touching secrets).
  const c = await findCamera(deps, query.camera, { password: 'later', capability: ['cctv.export', 'cctv.playback'], orgId: actor.orgId })
  if (!c.ok) {
    // A camera the person may not export (or that does not exist) is recorded as a refusal (P2-2, brief item 7).
    if (c.error === MSG_CAMERA_NOT_FOUND) await auditAccess(deps.admin, { orgId: actor.orgId, actorId: actor.id, action: 'cctv_export_denied', capability: 'cctv.export', cameraIds: [query.camera], detail: { reason: 'camera' } })
    return cameraFailure(c.error)
  }
  const exported = { orgId: actor.orgId, actorId: actor.id, capability: 'cctv.export' as const, cameraIds: [c.camera.id] }
  // "ended" is written only after "started", and only for a conversion that started (the process can end before this code goes on).
  const audit = { started: null as Promise<void> | null, exited: false }
  const auditEnded = () => void audit.started?.then(() => auditAccess(deps.admin, { ...exported, action: 'cctv_export_ended' }))
  // P2-5b: the recorder of the camera's active mapping, with its own address, login and clock offset.
  const { camera, recorder } = c
  if (signal?.aborted) return new Response(null, { status: 499 })

  const limits = deps.conversions ?? conversionLimiter
  const transfer = new AbortController() // ends everything of this request: the NVR transfer and the conversion
  let slot: Extract<ConversionSlot, { ok: true }> | null = null

  // P2-4 (D-3, AC-14, brief item 4): a download is a media session of kind vod (cctv.export AND cctv.playback, checked again by the
  // database for this person). It is opened at once and re-checked every 15 s while the transfer runs; when it is no longer allowed —
  // or cannot be checked for 45 s — the NVR transfer is aborted and ffmpeg is stopped. The probe downloads nothing and makes none.
  const registry = deps.registry ?? adminRegistry(deps.admin)
  let sid: string | null = null
  if (!query.probe) {
    try {
      sid = (await createMediaSessions(deps.admin, { orgId: actor.orgId, userId: actor.id, kind: 'vod', cameras: [{ id: camera.id, stream: null }], maxSec: Math.ceil(MAX_DOWNLOAD_MS / 1000) + 60 })).get(camera.id) ?? null
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
  let watch: SessionWatch | null = null
  let sessionEnded = false
  const endSession = () => {
    if (sessionEnded) return
    sessionEnded = true
    watch?.stop()
    if (sid) void registry.close(sid)
  }
  const login = await readRecorderLogin(deps, { camera, recorder, demo: false })
  if (!login.ok) {
    endSession()
    return cameraFailure(login.error)
  }
  const password = login.password

  if (query.probe) {
    const peek = limits.peek(actor.id, { ignoreOwn: true })
    if (!peek.ok) return fail(429, MSG_SERVER_BUSY)
  } else {
    const stop = () => transfer.abort()
    let taken = limits.acquire(actor.id, stop)
    if (!taken.ok && taken.reason === 'person') {
      // The person started something new: their earlier conversion is ended first, then this one goes ahead.
      await limits.supersede(actor.id, deps.timing?.supersedeMs ?? SUPERSEDE_WAIT_MS)
      taken = limits.acquire(actor.id, stop)
    }
    if (!taken.ok) {
      endSession()
      return fail(429, taken.reason === 'person' ? MSG_ALREADY_RUNNING : MSG_SERVER_BUSY)
    }
    slot = taken
    watch = watchSession({
      registry, sid: sid!, everyMs: deps.timing?.validateMs ?? VOD_VALIDATE_EVERY_MS, failClosedAfterMs: deps.timing?.failClosedMs ?? VOD_FAIL_CLOSED_AFTER_MS,
      onEnd: (reason) => {
        logger.warn({ event: 'vod_session_ended', reason })
        transfer.abort() // the NVR transfer stops and ffmpeg is told to stop (and killed after the grace time)
      },
    })
  }

  // From here on the slot is given back by whoever ends last: this function, or the conversion once it has started.
  const forward = () => transfer.abort()
  signal?.addEventListener('abort', forward, { once: true })
  let handedOver = false
  try {
    if (signal?.aborted || transfer.signal.aborted) return new Response(null, { status: 499 })
    // The recorder's own clock offset when it has one (P2-5b), else PLAYBACK_OFFSET_MIN.
    const offset = recorderOffset(recorder, deps.offsetMin ?? parsePlaybackOffset(env.PLAYBACK_OFFSET_MIN))
    const client = (deps.nvr ?? ((ep) => new NvrClient(ep)))({ host: recorder.host!, port: recorder.http_port, username: recorder.username, password: password! })

    // Shown time (ruling R13): the NVR is asked for shown time - offset.
    const startMs = query.start.getTime()
    let uri: string
    let family: 'h264' | 'h265' | null
    try {
      const found = await findSegments(client, { channel: camera.channel, day: query.start.toISOString().slice(0, 10), ...offset })
      const segment = found.segments.find((s) => s.start.getTime() <= startMs && startMs < s.end.getTime())
      if (!segment) return fail(404, MSG_NO_RECORDING)
      if (segment.uri === undefined) return fail(404, MSG_NOT_DOWNLOADABLE)
      const shift = clockOffsetMs(offset) ?? 0
      const to = Math.min(startMs + query.minutes * 60_000, segment.end.getTime())
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

    // Is there an ffmpeg at all? Asked before the NVR is bothered with a download that nothing could use.
    const program = resolveFfmpeg(env, deps.lookup)
    if (!program.ok) return fail(500, program.error)
    const available = deps.ffmpegAvailable ?? (deps.spawn ? async () => true : (e: Record<string, string | undefined>) => fastPlaybackAvailable(e))
    if (!(await available(env))) return fail(500, MSG_NO_FFMPEG)
    if (query.probe) return Response.json({ ok: true, codec: family }, { headers: HEADERS })

    let source: ReadableStream<Uint8Array>
    try {
      source = await client.postStream(DOWNLOAD_PATH, body, { signal: transfer.signal, maxMs: deps.timing?.transferMs ?? MAX_DOWNLOAD_MS, maxBytes: deps.timing?.maxBytes ?? MAX_DOWNLOAD_BYTES })
    } catch (e) {
      if (transfer.signal.aborted) return new Response(null, { status: 499 })
      return await nvrFailure(e, camera.code, 'vod_download_failed', deps.rls, recorder.id)
    }

    handedOver = true
    const converted = await startConversion({
      spawn: deps.spawn,
      ffmpeg: program.path,
      hevc: family === 'h265',
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
        return fail(500, MSG_NO_FFMPEG)
      }
      if (converted.reason === 'cancelled') return new Response(null, { status: 499 })
      if (converted.reason === 'timeout') return fail(502, await recorderMessage(deps.rls, recorder.id, describeNvrError(new NvrError('timeout', 'slow')), 'nvr_timeout'))
      if (converted.reason === 'format') return fail(502, MSG_FORMAT_UNSUPPORTED)
      return fail(502, MSG_CONVERT_FAILED)
    }
    audit.started = auditAccess(deps.admin, { ...exported, action: 'cctv_export_started', detail: { minutes: query.minutes } })
    if (audit.exited) auditEnded()
    await audit.started
    return new Response(converted.body, { status: 200, headers: { ...HEADERS, 'Content-Type': 'video/mp4' } })
  } finally {
    if (!handedOver) {
      signal?.removeEventListener('abort', forward)
      endSession()
      slot?.release()
    }
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
