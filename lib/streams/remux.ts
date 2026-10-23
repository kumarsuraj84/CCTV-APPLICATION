import { isProductionMode } from '@/lib/runtime-mode'
import {
  fastPlaybackAvailable,
  FIRST_BYTE_MS,
  MSG_NO_FFMPEG,
  resolveFfmpeg,
  SOURCE_IDLE_MS,
  startConversion,
  VOD_MAX_MS,
  type ConversionResult,
  type ProgramLookup,
  type SpawnFn,
} from '@/lib/streams/ffmpeg'

// P4-L2 (brief item 3): the step that turns an NVR download into the fragmented MP4 a browser plays is an ADAPTER, so that it can be
// tested without ffmpeg (which is not installed on the development PC) and so that a later H.265 → H.264 transcode (ruling E-2: an
// optional per-recorder setting, off by default, never for exports; Release 1.1 / P4-L5) plugs in without touching the routes.
//
//   ffmpeg       the real one: `-c:v copy` remux through lib/streams/ffmpeg.ts (unvalidated until ffmpeg is installed; runbook
//                docs/drishti/runbooks/ffmpeg.md).
//   passthrough  development only (FAST_PLAYBACK_REMUX=passthrough): the NVR's bytes as they are, for a fake NVR on this computer that
//                already serves a fragmented MP4. Refused in production and for any NVR that is not on this computer (loopback), so a real
//                NVR's download is never passed on raw.
// Tests use tests/helpers/fake-remux.ts.

export type RemuxStart = {
  env: Record<string, string | undefined>
  /** The NVR's bytes. */
  source: ReadableStream<Uint8Array>
  /** Ends the NVR transfer (safe to call more than once). */
  abortSource: () => void
  /** Aborted when the person goes away or access is gone. */
  signal?: AbortSignal
  /** The recording is H.265 (tagged hvc1 by ffmpeg). */
  hevc?: boolean
  /** Review I-1: read the input at this many times real time (ffmpeg -readrate; fast playback only). */
  readrate?: number
  /** Called exactly once, when the work is really over (the place to give a slot back and close the session). */
  onExit?: () => void
  maxMs?: number
  firstByteMs?: number
  idleMs?: number
  killGraceMs?: number
}
export type RemuxReady = { ok: true } | { ok: false; error: string }

export interface RemuxAdapter {
  readonly name: string
  /** Can this server do it now? `recorderHost`: the NVR's (checked) address, when known. Plain words when not. */
  check(env: Record<string, string | undefined>, o?: { recorderHost?: string | null }): Promise<RemuxReady>
  /** Starts the work; the answer comes once the first byte of output exists (a failure before that is still a plain error). */
  start(o: RemuxStart): Promise<ConversionResult>
}

/** The real adapter: ffmpeg, found with resolveFfmpeg (FFMPEG full path, else full-path PATH entries), checked once a minute. */
export function ffmpegRemux(o: { spawn?: SpawnFn; lookup?: ProgramLookup; available?: (env: Record<string, string | undefined>) => Promise<boolean> } = {}): RemuxAdapter {
  // With a stand-in spawn (tests) a start that fails is answered the same way, so the "does it run" probe is not needed.
  const available = o.available ?? (o.spawn ? async () => true : (env: Record<string, string | undefined>) => fastPlaybackAvailable(env))
  return {
    name: 'ffmpeg',
    async check(env) {
      const program = resolveFfmpeg(env, o.lookup)
      if (!program.ok) return { ok: false, error: program.error }
      return (await available(env)) ? { ok: true } : { ok: false, error: MSG_NO_FFMPEG }
    },
    async start(s) {
      const program = resolveFfmpeg(s.env, o.lookup)
      if (!program.ok) {
        s.abortSource()
        s.onExit?.()
        return { ok: false, reason: 'missing' }
      }
      return startConversion({
        spawn: o.spawn, ffmpeg: program.path, hevc: s.hevc, readrate: s.readrate, source: s.source, abortSource: s.abortSource, signal: s.signal, onExit: s.onExit,
        maxMs: s.maxMs, firstByteMs: s.firstByteMs, idleMs: s.idleMs, killGraceMs: s.killGraceMs,
      })
    },
  }
}

const LOOPBACK = /^(?:127\.\d{1,3}\.\d{1,3}\.\d{1,3}|::1|localhost)$/i

/** Review m-6: the pass-through ends after this long in all, and after this long without NVR data, whatever the caller passes. */
export const PASS_THROUGH_DEFAULTS = { maxMs: VOD_MAX_MS, idleMs: SOURCE_IDLE_MS }

/** Development only: the NVR's bytes unchanged (see the top of this file). */
export function passThroughRemux(): RemuxAdapter {
  return {
    name: 'passthrough',
    async check(env, o) {
      if (isProductionMode(env)) return { ok: false, error: MSG_NO_FFMPEG }
      // Review m-6: a recorder host must be a known loopback address; a missing or empty one is refused (only the page's "is it set up"
      // question, which names no recorder, gets a yes).
      if (o && 'recorderHost' in o && !(typeof o.recorderHost === 'string' && LOOPBACK.test(o.recorderHost.trim()))) return { ok: false, error: MSG_NO_FFMPEG }
      return { ok: true }
    },
    async start(s) {
      let ended = false
      let timer: ReturnType<typeof setTimeout> | undefined
      let idle: ReturnType<typeof setTimeout> | undefined
      const reader = s.source.getReader()
      const onAbort = () => {
        void reader.cancel().catch(() => {})
        end()
      }
      const end = () => {
        if (ended) return
        ended = true
        clearTimeout(timer)
        clearTimeout(idle)
        s.signal?.removeEventListener('abort', onAbort)
        s.abortSource()
        s.onExit?.()
      }
      const idleMs = s.idleMs ?? PASS_THROUGH_DEFAULTS.idleMs
      const armIdle = () => {
        clearTimeout(idle)
        idle = setTimeout(onAbort, idleMs)
      }
      const first = await new Promise<ReadableStreamReadResult<Uint8Array> | null>((resolve) => {
        timer = setTimeout(() => resolve(null), s.firstByteMs ?? FIRST_BYTE_MS)
        reader.read().then(resolve, () => resolve(null))
      })
      clearTimeout(timer)
      if (first === null || first.done) {
        void reader.cancel().catch(() => {})
        end()
        return { ok: false, reason: first === null ? 'timeout' : 'failed' }
      }
      timer = setTimeout(onAbort, s.maxMs ?? PASS_THROUGH_DEFAULTS.maxMs)
      if (s.signal?.aborted) onAbort()
      else s.signal?.addEventListener('abort', onAbort, { once: true })
      let sentFirst = false
      const body = new ReadableStream<Uint8Array>({
        async pull(c) {
          if (!sentFirst) {
            sentFirst = true
            c.enqueue(first.value)
            return
          }
          if (ended) {
            try {
              c.close()
            } catch {
              // already closed
            }
            return
          }
          try {
            armIdle() // the NVR is being waited for
            const next = await reader.read()
            clearTimeout(idle)
            if (next.done) {
              c.close()
              end()
            } else c.enqueue(next.value)
          } catch {
            try {
              c.error(new Error('The recording stopped.'))
            } catch {
              // already gone
            }
            end()
          }
        },
        cancel() {
          void reader.cancel().catch(() => {})
          end()
        },
      })
      return { ok: true, body }
    },
  }
}

/**
 * Review I-1: the start-up note about fast playback (null when it can work): the remux adapter is asked whether it is ready — for ffmpeg
 * that is a program that runs AND is 5.0 or newer (-readrate) — and the plain reason is given when not.
 */
export async function fastPlaybackStartupNote(env: Record<string, string | undefined> = process.env, adapter: RemuxAdapter = remuxFromEnv(env)): Promise<string | null> {
  try {
    const ready = await adapter.check(env)
    return ready.ok ? null : `Fast playback (2x-16x) is off: ${ready.error} (it needs ffmpeg 5.0 or newer; see docs/drishti/runbooks/ffmpeg.md).`
  } catch {
    return 'Fast playback (2x-16x) is off: the remux check failed.'
  }
}

/** The adapter this server uses: ffmpeg, unless FAST_PLAYBACK_REMUX=passthrough outside production. */
export function remuxFromEnv(env: Record<string, string | undefined> = process.env, o: { spawn?: SpawnFn; lookup?: ProgramLookup } = {}): RemuxAdapter {
  if ((env.FAST_PLAYBACK_REMUX ?? '').trim() === 'passthrough' && !isProductionMode(env)) return passThroughRemux()
  return ffmpegRemux(o)
}
