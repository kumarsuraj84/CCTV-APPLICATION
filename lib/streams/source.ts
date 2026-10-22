import { createHash } from 'node:crypto'
import { isIP } from 'node:net'
import { clockOffsetMs, type ClockOffset } from '@/lib/nvr/playback'
import { isValidHost, isValidPort } from '@/lib/probes'
import { isProductionMode } from '@/lib/runtime-mode'

// The camera password is part of what these functions return. Keep the result on the server: it goes to go2rtc and nowhere else.
// Errors are plain and never echo the host, the credentials or the URL.

const BAD_ADDRESS = 'The camera address is not valid.'

/** encodeURIComponent leaves ! ' ( ) * alone; encode them too so the text is safe in any URL user-info position. */
const enc = (s: string) => encodeURIComponent(s).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`)

type Target = { host: string; port: number; username: string; password: string; channel: number }

function authority(o: Target): string {
  if (typeof o.username !== 'string' || typeof o.password !== 'string') throw new Error(BAD_ADDRESS)
  if (typeof o.host !== 'string' || !isValidHost(o.host) || !isValidPort(o.port)) throw new Error(BAD_ADDRESS)
  if (!Number.isInteger(o.channel) || o.channel < 1 || o.channel > 4096) throw new Error(BAD_ADDRESS)
  const host = isIP(o.host) === 6 ? `[${o.host}]` : o.host
  return `rtsp://${enc(o.username)}:${enc(o.password)}@${host}:${o.port}`
}

export function buildRtspUrl(o: { host: string; port: number; username: string; password: string; channel: number; kind: 'sub' | 'main' }): string {
  if (o.kind !== 'sub' && o.kind !== 'main') throw new Error(BAD_ADDRESS)
  return `${authority(o)}/Streaming/Channels/${o.channel}0${o.kind === 'sub' ? 2 : 1}`
}

const two = (n: number) => String(n).padStart(2, '0')
function nvrInstant(d: Date, offsetMs: number): string {
  const t = new Date(d.getTime() - offsetMs)
  if (!Number.isFinite(t.getTime())) throw new Error(BAD_ADDRESS)
  return `${t.getUTCFullYear()}${two(t.getUTCMonth() + 1)}${two(t.getUTCDate())}T${two(t.getUTCHours())}${two(t.getUTCMinutes())}${two(t.getUTCSeconds())}Z`
}

/**
 * Ruling R13: the NVR is asked for shown time - offset, so both instants are shifted back by the offset. The offset is the recorder's
 * own (`offsetSec`, P2-5b) or the global default (`offsetMin`, PLAYBACK_OFFSET_MIN): exactly one of the two.
 */
export function buildPlaybackUrl(o: { host: string; port: number; username: string; password: string; channel: number; start: Date; end: Date } & ClockOffset): string {
  const ok = (d: unknown): d is Date => d instanceof Date && Number.isFinite(d.getTime())
  if (!ok(o.start) || !ok(o.end) || o.end.getTime() <= o.start.getTime()) throw new Error(BAD_ADDRESS)
  const offset = clockOffsetMs(o)
  if (offset === null) throw new Error(BAD_ADDRESS)
  const base = authority(o)
  const starttime = nvrInstant(o.start, offset)
  const endtime = nvrInstant(o.end, offset)
  return `${base}/Streaming/tracks/${o.channel}01?starttime=${starttime}&endtime=${endtime}`
}

const PATTERNS = ['testsrc', 'testsrc2', 'smptebars', 'rgbtestsrc']

/**
 * go2rtc's own generated test picture, used instead of a real camera in demo mode. Verified against go2rtc 1.9.9: this source can be
 * registered through the API (a user-written `exec:` source cannot) and yields real H.264 frames. go2rtc runs ffmpeg for it and
 * publishes to its own RTSP listener, so the demo config (deploy/go2rtc.demo.yaml, `npm run stack:up:demo`) listens on 127.0.0.1:8554 (inside the container only, not published).
 * go2rtc publishes each of these under a path made from the whole source text, so two cameras with the same pattern would fight over one
 * path and one of them would never start. Pass the camera id and every camera gets its own source: an (invisible) very long duration whose
 * decimals come from the id.
 */
export function demoSource(channel: number, cameraId?: string): string {
  if (!Number.isInteger(channel)) throw new Error('Invalid channel')
  const pattern = PATTERNS[((channel % 4) + 4) % 4]
  const own = cameraId === undefined ? '' : `&duration=86400.${parseInt(createHash('sha256').update(cameraId).digest('hex').slice(0, 10), 16)}`
  return `ffmpeg:virtual?video=${pattern}&size=640x360${own}#video=h264`
}

const LOOPBACK = new Set(['127.0.0.1', 'localhost', '::1'])

/** True only on a development machine with DEMO_VIDEO=1 and a recorder (NVR) whose address is this machine (P2-5b: per recorder). */
export function isDemoRecorder(o: { host: string | null }, env: Record<string, string | undefined> = process.env): boolean {
  // P2-6 review round 1 (I-1): the shared production switch, not NODE_ENV alone.
  return env.DEMO_VIDEO === '1' && !isProductionMode(env) && typeof o.host === 'string' && LOOPBACK.has(o.host)
}
