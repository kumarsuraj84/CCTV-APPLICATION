import { spawn as nodeSpawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { accessSync, constants, statSync } from 'node:fs'
import path from 'node:path'
import { Readable } from 'node:stream'
import type { ReadableStream as NodeWebStream } from 'node:stream/web'
import { MAX_DOWNLOAD_MS } from '@/lib/nvr/client'
import { logger } from '@/lib/observability/logger'
import { processSingleton } from '@/lib/process-singleton'

// The ffmpeg program: finding it, starting it safely and piping a recording through it (moved here from lib/streams/vod.ts in P4-L2 so that
// the remux adapter, lib/streams/remux.ts, can use it without an import cycle; vod.ts re-exports everything as before). ffmpeg is an
// OPTIONAL program on the server and is NOT installed on the development PC: the real program is unvalidated until it is installed
// (docs/drishti/runbooks/ffmpeg.md); tests use a stand-in process (tests/helpers/fake-ffmpeg.mjs) or the fake adapter.
//
//   browser <-- fragmented MP4 -- this process <-- bytes -- ffmpeg (stdin <- the NVR's download)

/** The longest a conversion runs: a little less than the longest NVR transfer, so the video ends cleanly before the transfer's own deadline cuts it. */
export const VOD_MAX_MS = MAX_DOWNLOAD_MS - 30_000
/** A conversion that has not produced its first byte after this long is given up. */
export const FIRST_BYTE_MS = 30_000
/** After asking ffmpeg to stop (SIGTERM), this long passes before it is killed outright (SIGKILL). */
export const KILL_GRACE_MS = 3_000
/** The most of ffmpeg's error output that is kept. */
export const STDERR_CAP_BYTES = 8 * 1024
/** A conversion ends when the NVR has sent nothing for this long while it was being waited for (not while the viewer is slow). */
export const SOURCE_IDLE_MS = 60_000
/** How long "ffmpeg works" is remembered. */
export const AVAILABILITY_TTL_MS = 60_000

export const MSG_NO_FFMPEG = 'ffmpeg is not installed on the server'
export const MSG_FFMPEG_PATH = 'FFMPEG must be the full path of the ffmpeg program.'

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
 * standard output. `-xerror` is left out on purpose: a recording with one damaged frame should still play. Ruling E-2: a remux (`-c:v
 * copy`), never a re-encode.
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
