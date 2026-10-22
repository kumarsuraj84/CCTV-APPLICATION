// Small pure rules of the administration forms (P2-5c-1). No server imports: client components use them to explain things before the
// Server Action checks them again, and the database checks the same things a third time (constraints and triggers).

export const LOCATION_KINDS = ['store', 'head_office', 'dc', 'warehouse', 'other'] as const
export type LocationKind = (typeof LOCATION_KINDS)[number]
export const LOCATION_KIND_LABELS: Record<LocationKind, string> = {
  store: 'Store', head_office: 'Head office', dc: 'Distribution centre', warehouse: 'Warehouse', other: 'Other',
}
export const isLocationKind = (v: unknown): v is LocationKind => typeof v === 'string' && (LOCATION_KINDS as readonly string[]).includes(v)

/** The asset types of the database enum, without the NVR (an NVR is a recorder of a location and is added on its page). */
export const ASSET_TYPES = ['server', 'attendance', 'footfall', 'sdwan_edge', 'switch', 'access_point', 'router', 'ups', 'printer', 'desktop', 'laptop', 'other'] as const
export type AssetType = (typeof ASSET_TYPES)[number]
export const ASSET_TYPE_LABELS: Record<AssetType | 'nvr', string> = {
  nvr: 'NVR', server: 'Server', attendance: 'Attendance machine', footfall: 'Footfall counter', sdwan_edge: 'SD-WAN edge', switch: 'Switch',
  access_point: 'Wi-Fi access point', router: 'Router', ups: 'UPS', printer: 'Printer', desktop: 'Desktop PC', laptop: 'Laptop', other: 'Other',
}
export const CRITICALITIES = ['low', 'medium', 'high', 'critical'] as const
export const LIFECYCLE_STATES = ['planned', 'active', 'maintenance', 'retired', 'disposed'] as const
export const LIFECYCLE_LABELS: Record<(typeof LIFECYCLE_STATES)[number], string> = {
  planned: 'Planned', active: 'In use', maintenance: 'In maintenance', retired: 'Retired', disposed: 'Disposed of',
}
export const DEPENDENCY_KINDS = ['network', 'power', 'recording'] as const
export const DEPENDENCY_LABELS: Record<(typeof DEPENDENCY_KINDS)[number], string> = { network: 'Network', power: 'Power', recording: 'Recording' }
export const ENDPOINT_PURPOSES = ['snmp', 'other'] as const
export const ENDPOINT_PURPOSE_LABELS: Record<string, string> = { management: 'Management', rtsp: 'Video (RTSP)', snmp: 'SNMP', other: 'Other' }

/**
 * Review I-1: what a move does to video that is ALREADY open. True until the session registry (P2-4) re-checks open sessions; when
 * P2-4 lands, change this sentence (and its unit test) to say that open video stops within a minute.
 */
export const MSG_OPEN_VIDEO = 'Video that is already open is not cut off yet: it keeps playing until the person closes it.'

/** "PTN1 - Patna" stays as it is; "Head office, Patna" gets its code in front (review M-12: no "PTN1 · PTN1 - Patna"). */
export const locationTitle = (code: string, name: string): string => (name.toUpperCase().startsWith(code.toUpperCase()) ? name : `${code} · ${name}`)

export type MergePreview = { keepName: string; duplicateName: string; duplicatePlace: string; peopleLosing: number }
/** The confirmation of a merge, naming both cameras, the duplicate's place and who loses access (review I-5 / M-3). */
export function mergeSentence(p: MergePreview): string {
  const linked = p.duplicatePlace.includes(', channel ')
  const first = linked
    ? `“${p.keepName}” keeps its identity, access, groups and history and takes over the NVR channel of “${p.duplicateName}” (${p.duplicatePlace}), which is archived.`
    : `“${p.keepName}” keeps its identity, access, groups and history; “${p.duplicateName}” (${p.duplicatePlace}) is archived.`
  const second = p.peopleLosing === 0
    ? `Nobody loses access through a grant on “${p.duplicateName}”.`
    : `${p.peopleLosing} ${p.peopleLosing === 1 ? 'person has' : 'people have'} access to “${p.duplicateName}” only through a grant on it; that access ends.`
  return `${first} ${second}`
}

/** A region, cluster or location code: letters, numbers and dashes, upper case, 1 to 50, starting with a letter or number. */
export function normaliseCode(v: unknown): string | null {
  const t = typeof v === 'string' ? v.trim().toUpperCase() : ''
  return /^[A-Z0-9][A-Z0-9-]{0,49}$/.test(t) ? t : null
}

/** The display name a location starts with (ruling R-1 amendment): "CODE - City", or the code alone. Editable later. */
export const displayName = (code: string, city: string | null | undefined): string => (city && city.trim() ? `${code} - ${city.trim()}` : code)

type Parsed<T> = { ok: true; value: T } | { ok: false; error: string }

export const MSG_CLOCK_OFFSET = 'The clock offset must be a whole number of seconds from -86400 to 86400.'
/** Seconds to take off a shown time to get the NVR's time (ruling R13 direction); empty = not set (the default applies). */
export function parseClockOffset(v: unknown): Parsed<number | null> {
  const t = String(v ?? '').trim()
  if (t === '') return { ok: true, value: null }
  if (!/^-?\d+$/.test(t)) return { ok: false, error: MSG_CLOCK_OFFSET }
  const n = Number(t)
  return Math.abs(n) <= 86400 ? { ok: true, value: n } : { ok: false, error: MSG_CLOCK_OFFSET }
}

/** A channel number from 1 to 999, or null. */
export function parseChannel(v: unknown): number | null {
  const t = String(v ?? '').trim()
  if (!/^\d+$/.test(t)) return null
  const n = Number(t)
  return n >= 1 && n <= 999 ? n : null
}

/** A whole number in a range, from a form field; empty gives `empty`. */
export function parseWhole(v: unknown, min: number, max: number, empty: number | null): number | null | undefined {
  const t = String(v ?? '').trim()
  if (t === '') return empty
  if (!/^-?\d+$/.test(t)) return undefined
  const n = Number(t)
  return n >= min && n <= max ? n : undefined
}

/** Items separated by commas, spaces or new lines. */
export const parseList = (v: unknown): string[] => String(v ?? '').split(/[\s,;]+/).map((x) => x.trim()).filter(Boolean)

const IPV4 = /^(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(\.(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3}$/
const IPV6 = /^[0-9a-f:]+$/i
export const isIpv4 = (v: string): boolean => IPV4.test(v)
export const isIp = (v: string): boolean => IPV4.test(v) || (v.includes(':') && IPV6.test(v) && v.length <= 39)

/** "10.20.0.0/24" (IPv4 with a prefix length; IPv6 with /0../128). */
export function isCidr(v: string): boolean {
  const m = /^([^/]+)\/(\d{1,3})$/.exec(v.trim())
  if (!m) return false
  const bits = Number(m[2])
  if (isIpv4(m[1])) return bits <= 32
  return isIp(m[1]) && bits <= 128
}

const HOSTNAME = /^[A-Za-z0-9]([A-Za-z0-9-]{0,61}[A-Za-z0-9])?(\.[A-Za-z0-9]([A-Za-z0-9-]{0,61}[A-Za-z0-9])?)*$/
/** An IP address or a host name (what an endpoint or NVR address may be). */
export const isHostOrIp = (v: string): boolean => {
  const t = v.trim()
  return t.length > 0 && t.length <= 253 && (isIp(t) || HOSTNAME.test(t))
}

export const MSG_VLAN = 'VLAN numbers are whole numbers from 1 to 4094.'
export function parseVlan(v: unknown): Parsed<number | null> {
  const n = parseWhole(v, 1, 4094, null)
  return n === undefined ? { ok: false, error: MSG_VLAN } : { ok: true, value: n }
}

/** A day "YYYY-MM-DD" that exists, or null for empty; undefined when it is not a real day. */
export function parseDay(v: unknown): string | null | undefined {
  const t = String(v ?? '').trim()
  if (t === '') return null
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(t)
  if (!m) return undefined
  const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])))
  return d.getUTCFullYear() === Number(m[1]) && d.getUTCMonth() === Number(m[2]) - 1 && d.getUTCDate() === Number(m[3]) ? t : undefined
}

/** Optional text: trimmed, empty → null, at most `max` characters (undefined when longer). */
export function optionalText(v: unknown, max: number): string | null | undefined {
  const t = String(v ?? '').trim()
  if (t === '') return null
  return t.length <= max ? t : undefined
}
