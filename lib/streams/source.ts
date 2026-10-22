import { isIP } from 'node:net'
import { isValidHost, isValidPort } from '@/lib/probes'

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
const MAX_OFFSET_MIN = 1440
function nvrInstant(d: Date, offsetMin: number): string {
  const t = new Date(d.getTime() - offsetMin * 60_000)
  if (!Number.isFinite(t.getTime())) throw new Error(BAD_ADDRESS)
  return `${t.getUTCFullYear()}${two(t.getUTCMonth() + 1)}${two(t.getUTCDate())}T${two(t.getUTCHours())}${two(t.getUTCMinutes())}${two(t.getUTCSeconds())}Z`
}

/** NVR time = true time + offset, so both instants are shifted back by offsetMin. */
export function buildPlaybackUrl(o: { host: string; port: number; username: string; password: string; channel: number; start: Date; end: Date; offsetMin: number }): string {
  const ok = (d: unknown): d is Date => d instanceof Date && Number.isFinite(d.getTime())
  if (!ok(o.start) || !ok(o.end) || o.end.getTime() <= o.start.getTime()) throw new Error(BAD_ADDRESS)
  if (typeof o.offsetMin !== 'number' || !Number.isFinite(o.offsetMin) || Math.abs(o.offsetMin) > MAX_OFFSET_MIN) throw new Error(BAD_ADDRESS)
  const base = authority(o)
  const starttime = nvrInstant(o.start, o.offsetMin)
  const endtime = nvrInstant(o.end, o.offsetMin)
  return `${base}/Streaming/tracks/${o.channel}01?starttime=${starttime}&endtime=${endtime}`
}

const PATTERNS = ['testsrc', 'testsrc2', 'smptebars', 'rgbtestsrc']

/** A go2rtc exec source that makes a moving test picture, used instead of a real camera in demo mode. */
export function demoSource(channel: number): string {
  if (!Number.isInteger(channel)) throw new Error('Invalid channel')
  const pattern = PATTERNS[((channel % 4) + 4) % 4]
  return `exec:ffmpeg -re -f lavfi -i ${pattern}=size=640x360:rate=10 -c:v libx264 -preset ultrafast -tune zerolatency -g 20 -rtsp_transport tcp -f rtsp {output}`
}

const LOOPBACK = new Set(['127.0.0.1', 'localhost', '::1'])

/** True only on a development machine with DEMO_VIDEO=1 and a store whose NVR address is this machine. */
export function isDemoStore(o: { code: string; nvr_ip: string }, env: Record<string, string | undefined> = process.env): boolean {
  return env.DEMO_VIDEO === '1' && env.NODE_ENV !== 'production' && LOOPBACK.has(o.nvr_ip)
}
