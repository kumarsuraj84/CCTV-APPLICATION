import { promises as dnsPromises } from 'node:dns'
import { BlockList, isIP } from 'node:net'
import { processSingleton } from '@/lib/process-singleton'

// The same host rule as lib/probes.ts isValidHost (kept here so that the probes can use this module without a cycle): a canonical IP
// or a plain host name; never a numeric/hex spelling of an address, a credential, a path, a port or a leading "-".
const HOSTNAME = /^[A-Za-z0-9]([A-Za-z0-9_-]{0,61}[A-Za-z0-9])?(\.[A-Za-z0-9]([A-Za-z0-9_-]{0,61}[A-Za-z0-9])?)*\.?$/
const NUMERIC_LAST_LABEL = /(^|\.)(\d+|0x[0-9a-f]*)$/i
function isValidHost(h: string): boolean {
  if (typeof h !== 'string' || h.length === 0 || h.length > 253) return false
  if (isIP(h) !== 0) return !h.includes('%')
  return HOSTNAME.test(h) && !NUMERIC_LAST_LABEL.test(h.replace(/\.$/, ''))
}

// Outbound target restriction (P2-6 brief item 5, SO-4, D-13). Every outbound connection of this application — device and NVR probes,
// NVR (ISAPI) requests, RTSP checks, camera discovery, go2rtc stream sources, recording downloads, later SNMP/WinRM/SSH/VNC — asks this
// module first. Two layers:
//
//  1. connectRefusal(host): the backstop in front of every socket (lib/probes.ts tcpCheck/icmpCheck, lib/rtsp/describe.ts,
//     lib/nvr/client.ts, go2rtc sources). Link-local, cloud metadata, unspecified, multicast, broadcast and reserved addresses are never
//     reached; loopback ("this computer") only outside production (the development fakes and the demo NVR live there).
//  2. checkTarget({host, port, purpose}): the application's question "may I connect to host:port for this purpose?". Only endpoints
//     this process read from the database (registered recorder and asset endpoints: the loaders call registerEndpoints) or the explicit
//     allow-list OUTBOUND_TARGET_ALLOWLIST pass; a known host on another port is a port mismatch; a host NAME is resolved once and
//     pinned, and a later answer that shares no address with the pinned one is refused (DNS rebinding). It returns the address to
//     connect to, so the connection itself never resolves the name again.
//
// Refusals are plain sentences that never repeat the address, and no socket is opened for them.

export type TargetPurpose =
  | 'device_tcp' | 'device_icmp' | 'nvr_http' | 'nvr_rtsp' | 'discovery' | 'connection_test' | 'stream_source' | 'recording_download'
  | 'snmp' | 'winrm' | 'ssh' | 'vnc'

export type AddressClass = 'loopback' | 'metadata' | 'link_local' | 'unspecified' | 'multicast' | 'broadcast' | 'reserved' | 'private' | 'public' | 'invalid'
export type TargetDecision = { ok: true; address: string } | { ok: false; error: string }
type Env = Record<string, string | undefined>

export const MSG_SPECIAL_ADDRESS = 'This address cannot be used: it is a reserved or special network address.'
export const MSG_THIS_COMPUTER = 'This address cannot be used: it points at this computer, which is only allowed in development.'
export const MSG_NOT_REGISTERED = 'This address is not a registered NVR or device address, so no connection is made.'
export const MSG_PORT_MISMATCH = 'This port is not the one registered for this NVR or device, so no connection is made.'
export const MSG_DNS_CHANGED = 'The name of this NVR or device now points to a different address than when it was first checked, so no connection is made. Check the address and save it again.'
export const MSG_BAD_TARGET = 'That address or port is not valid.'
export const MSG_NAME_NOT_FOUND = 'That name cannot be found.'
export const MSG_BAD_SOURCE = 'The video source is not an NVR address this server knows, so it was not used.'
export const MSG_DEMO_ONLY_DEV = 'The generated test picture is only available in development.'

/** An endpoint read from the database is reachable for this long after it was last read (the worker reads every round). */
export const REGISTRATION_TTL_MS = 60 * 60_000
/** A name's first answer is kept this long; within it an answer sharing no address with it is refused. */
export const DNS_PIN_TTL_MS = 12 * 60 * 60_000

const block = (list: [string, number, 'ipv4' | 'ipv6'][]) => {
  const b = new BlockList()
  for (const [net, prefix, type] of list) b.addSubnet(net, prefix, type)
  return b
}
const CLASSES: [AddressClass, BlockList][] = [
  ['metadata', block([['169.254.169.254', 32, 'ipv4'], ['169.254.170.2', 32, 'ipv4'], ['100.100.100.200', 32, 'ipv4'], ['fd00:ec2::254', 128, 'ipv6']])],
  ['loopback', block([['127.0.0.0', 8, 'ipv4'], ['::1', 128, 'ipv6']])],
  ['link_local', block([['169.254.0.0', 16, 'ipv4'], ['fe80::', 10, 'ipv6']])],
  ['unspecified', block([['0.0.0.0', 8, 'ipv4'], ['::', 128, 'ipv6']])],
  ['broadcast', block([['255.255.255.255', 32, 'ipv4']])],
  ['multicast', block([['224.0.0.0', 4, 'ipv4'], ['ff00::', 8, 'ipv6']])],
  ['reserved', block([['240.0.0.0', 4, 'ipv4'], ['192.0.0.0', 24, 'ipv4'], ['198.18.0.0', 15, 'ipv4']])],
  ['private', block([['10.0.0.0', 8, 'ipv4'], ['172.16.0.0', 12, 'ipv4'], ['192.168.0.0', 16, 'ipv4'], ['100.64.0.0', 10, 'ipv4'], ['fc00::', 7, 'ipv6']])],
]
const MAPPED = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i

/** What kind of address an IP literal is (an IPv4-mapped IPv6 address counts as its IPv4 address). */
export function addressClass(ip: string): AddressClass {
  if (typeof ip !== 'string') return 'invalid'
  const bare = ip.replace(/^\[|\]$/g, '')
  const mapped = MAPPED.exec(bare)
  const addr = mapped ? mapped[1] : bare
  const family = isIP(addr)
  if (family === 0 || addr.includes('%')) return 'invalid'
  const type = family === 4 ? 'ipv4' : 'ipv6'
  for (const [kind, list] of CLASSES) if (list.check(addr, type)) return kind
  return 'public'
}

const isProduction = (env: Env) => env.NODE_ENV === 'production'
const normHost = (h: string) => h.trim().replace(/^\[|\]$/g, '').replace(/\.$/, '').toLowerCase()
const METADATA_NAMES = new Set(['metadata', 'metadata.google.internal', 'instance-data', 'instance-data.ec2.internal', 'metadata.azure.internal'])

/** The refusal for one address class, or null when it may be reached. */
function classRefusal(kind: AddressClass, env: Env): string | null {
  if (kind === 'invalid') return MSG_BAD_TARGET
  if (kind === 'loopback') return isProduction(env) ? MSG_THIS_COMPUTER : null
  if (kind === 'private' || kind === 'public') return null
  return MSG_SPECIAL_ADDRESS
}

/**
 * The backstop in front of every socket: null when `host` may be connected to, else a plain refusal. An IP literal is judged by its
 * class; a name by the names that always mean this computer or a metadata service (other names are resolved by checkTarget).
 */
export function connectRefusal(host: string, env: Env = process.env): string | null {
  if (typeof host !== 'string' || host.trim() === '') return MSG_BAD_TARGET
  const h = normHost(host)
  if (isIP(h) !== 0 || MAPPED.test(h)) return classRefusal(addressClass(h), env)
  if (!isValidHost(h)) return MSG_BAD_TARGET
  if (h === 'localhost' || h.endsWith('.localhost')) return classRefusal('loopback', env)
  if (METADATA_NAMES.has(h)) return MSG_SPECIAL_ADDRESS
  return null
}

// ── Registered endpoints (from the database) and pinned names ──────────────────
type State = { registered: Map<string, number>; hosts: Map<string, number>; pins: Map<string, { addresses: Set<string>; at: number }> }
const state = processSingleton('security.targets', (): State => ({ registered: new Map(), hosts: new Map(), pins: new Map() }))
const key = (host: string, port: number | null) => `${normHost(host)}|${port ?? 'icmp'}`

/**
 * Called by every loader that reads recorder or asset endpoints from the database (worker jobs, the media path's camera routes,
 * discovery, the connection test): these host:port pairs may be reached for the next hour. `port` null: a device checked by ping.
 */
export function registerEndpoints(list: readonly { host: string | null | undefined; port: number | null | undefined }[], now: number = Date.now()): void {
  for (const e of list) {
    if (typeof e.host !== 'string' || e.host.trim() === '') continue
    const port = typeof e.port === 'number' && Number.isInteger(e.port) && e.port >= 1 && e.port <= 65535 ? e.port : null
    state.registered.set(key(e.host, port), now)
    state.hosts.set(normHost(e.host), now)
  }
}

/** Tests only: forget every registration and pin. */
export function forgetTargetsForTest(): void {
  state.registered.clear()
  state.hosts.clear()
  state.pins.clear()
}

function allowListed(host: string, port: number | null, env: Env): boolean {
  const raw = env.OUTBOUND_TARGET_ALLOWLIST
  if (!raw) return false
  const want = key(host, port)
  return raw.split(',').map((s) => s.trim()).filter(Boolean).some((entry) => {
    const m = /^\[?([^\]]+?)\]?:(\d{1,5})$/.exec(entry)
    return m ? key(m[1], Number(m[2])) === want : false
  })
}

function registration(host: string, port: number | null, env: Env, now: number): string | null {
  const at = state.registered.get(key(host, port))
  if (at !== undefined && now - at <= REGISTRATION_TTL_MS) return null
  if (allowListed(host, port, env)) return null
  const hostAt = state.hosts.get(normHost(host))
  return hostAt !== undefined && now - hostAt <= REGISTRATION_TTL_MS ? MSG_PORT_MISMATCH : MSG_NOT_REGISTERED
}

type Lookup = (name: string) => Promise<{ address: string; family: number }[]>
const defaultLookup: Lookup = (name) => dnsPromises.lookup(name, { all: true, verbatim: true })

/**
 * May this process connect to host:port for this purpose? Only a registered endpoint (or one on OUTBOUND_TARGET_ALLOWLIST), never a
 * special address, a name only while it keeps resolving to its pinned address. Returns the address to connect to. Never throws.
 */
export async function checkTarget(
  req: { host: string; port: number | null; purpose: TargetPurpose },
  o: { env?: Env; lookup?: Lookup; now?: number } = {},
): Promise<TargetDecision> {
  const env = o.env ?? process.env
  const now = o.now ?? Date.now()
  const port = req.port
  if (typeof req.host !== 'string' || !isValidHost(normHost(req.host))) return { ok: false, error: MSG_BAD_TARGET }
  if (port === null ? req.purpose !== 'device_icmp' : !(Number.isInteger(port) && port >= 1 && port <= 65535)) return { ok: false, error: MSG_BAD_TARGET }
  const host = normHost(req.host)
  const notRegistered = registration(host, port, env, now)
  if (notRegistered) return { ok: false, error: notRegistered }
  const refused = connectRefusal(host, env)
  if (refused) return { ok: false, error: refused }
  if (isIP(host) !== 0 || MAPPED.test(host)) return { ok: true, address: host }

  let answers: string[]
  try {
    answers = (await (o.lookup ?? defaultLookup)(host)).map((a) => a.address)
  } catch {
    return { ok: false, error: MSG_NAME_NOT_FOUND }
  }
  if (answers.length === 0) return { ok: false, error: MSG_NAME_NOT_FOUND }
  for (const a of answers) {
    const r = classRefusal(addressClass(a), env)
    if (r) return { ok: false, error: r }
  }
  const pin = state.pins.get(host)
  let address: string
  if (pin && now - pin.at <= DNS_PIN_TTL_MS) {
    const same = answers.filter((a) => pin.addresses.has(a))
    if (same.length === 0) return { ok: false, error: MSG_DNS_CHANGED }
    address = same[0]
  } else {
    state.pins.set(host, { addresses: new Set(answers), at: now })
    address = answers[0]
  }
  // The pinned address of a registered name is registered too (a go2rtc source is built with the address, not the name).
  state.registered.set(key(address, port), now)
  return { ok: true, address }
}

/**
 * The media path's check of one NVR (live, playback, fast playback): its web and video ports must both pass checkTarget. Returns the
 * address to use for both, so the NVR request and the go2rtc source never resolve a name again.
 */
export async function checkRecorderTarget(
  r: { host: string | null; http_port: number; rtsp_port: number },
  o: { env?: Env; lookup?: Lookup; now?: number } = {},
): Promise<TargetDecision> {
  if (!r.host) return { ok: false, error: MSG_BAD_TARGET }
  const web = await checkTarget({ host: r.host, port: r.http_port, purpose: 'nvr_http' }, o)
  if (!web.ok) return web
  const video = await checkTarget({ host: r.host, port: r.rtsp_port, purpose: 'nvr_rtsp' }, o)
  if (!video.ok) return video
  return web
}

// ── go2rtc sources ─────────────────────────────────────────────────────────────
const DEMO = /^ffmpeg:virtual\?video=(testsrc|testsrc2|smptebars|rgbtestsrc)&size=640x360(&duration=86400\.\d{1,20})?#video=h264$/

/**
 * Whether a go2rtc source may be registered (D-13): only `rtsp://` / `rtsps://` to a registered recorder endpoint (no `#` options,
 * nothing that is not a plain URL), plus the generated demo picture outside production. Never `exec:`, `echo:`, `expr:`, any other
 * `ffmpeg:` input, `http`, `rtmp` or `webrtc`. Null when allowed; the refusal never repeats the source (it holds a password).
 */
export function sourceRefusal(src: string, env: Env = process.env, now: number = Date.now()): string | null {
  if (typeof src !== 'string' || src.length === 0 || src.length > 4096) return MSG_BAD_SOURCE
  if (DEMO.test(src)) return isProduction(env) ? MSG_DEMO_ONLY_DEV : null
  if (/[\s#\\]/.test(src) || /[\x00-\x1f\x7f]/.test(src)) return MSG_BAD_SOURCE
  let u: URL
  try {
    u = new URL(src)
  } catch {
    return MSG_BAD_SOURCE
  }
  if (u.protocol !== 'rtsp:' && u.protocol !== 'rtsps:') return MSG_BAD_SOURCE
  const host = normHost(u.hostname)
  const port = u.port ? Number(u.port) : u.protocol === 'rtsps:' ? 322 : 554
  if (connectRefusal(host, env)) return MSG_BAD_SOURCE
  return registration(host, port, env, now) ? MSG_BAD_SOURCE : null
}
