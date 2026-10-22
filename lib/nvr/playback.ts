import { randomUUID } from 'node:crypto'
import { NvrError, type NvrClient } from '@/lib/nvr/client'
import { ascii, elements, firstElement, text } from '@/lib/nvr/isapi'

// Recording search and calendar on the NVR (Hikvision ISAPI). Answers are read with the same linear scans as lib/nvr/isapi.ts.
// Time zones (ruling R13): the time shown to people minus `offsetMin` is what the NVR is asked for; the time shown for an NVR time is
// NVR time + `offsetMin`. All times below are plain instants (Date); the NVR itself is always spoken to in `yyyy-mm-ddThh:mm:ssZ`.

export type Segment = { start: Date; end: Date }

const BAD_INPUT = 'Invalid playback request.'
const MAX_CHANNEL = 4096
const MAX_LIMIT = 200
const MAX_POSITION = 1_000_000
/** Most segments kept from one answer, and from one findSegments call. */
export const MAX_SEGMENTS = 5000
/** Most pages one findSegments call reads, whatever the NVR says. */
export const MAX_PAGES = 50
const MAX_OFFSET_MIN = 1440
const SEARCH_ID = /^[A-Za-z0-9-]{1,64}$/

const two = (n: number) => String(n).padStart(2, '0')
const isDate = (d: unknown): d is Date => d instanceof Date && Number.isFinite(d.getTime())
const isChannel = (n: unknown): n is number => typeof n === 'number' && Number.isInteger(n) && n >= 1 && n <= MAX_CHANNEL
const escapeXml = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`)

function utcStamp(d: Date): string {
  const y = d.getUTCFullYear()
  if (y < 1970 || y > 9999) throw new Error(BAD_INPUT)
  return `${String(y).padStart(4, '0')}-${two(d.getUTCMonth() + 1)}-${two(d.getUTCDate())}T${two(d.getUTCHours())}:${two(d.getUTCMinutes())}:${two(d.getUTCSeconds())}Z`
}

/** The body of a recording search for one camera and one span of NVR time. Every input is checked; errors never echo the input. */
export function buildSearchBody(o: { channel: number; start: Date; end: Date; position: number; limit: number; searchId: string }): string {
  if (!isChannel(o.channel)) throw new Error(BAD_INPUT)
  if (!isDate(o.start) || !isDate(o.end) || o.end.getTime() <= o.start.getTime()) throw new Error(BAD_INPUT)
  if (typeof o.position !== 'number' || !Number.isInteger(o.position) || o.position < 0 || o.position > MAX_POSITION) throw new Error(BAD_INPUT)
  if (typeof o.limit !== 'number' || !Number.isInteger(o.limit) || o.limit < 1 || o.limit > MAX_LIMIT) throw new Error(BAD_INPUT)
  if (typeof o.searchId !== 'string' || !SEARCH_ID.test(o.searchId)) throw new Error(BAD_INPUT)
  return (
    '<CMSearchDescription>' +
    `<searchID>${escapeXml(o.searchId)}</searchID>` +
    `<trackIDList><trackID>${o.channel}01</trackID></trackIDList>` +
    `<timeSpanList><timeSpan><startTime>${utcStamp(o.start)}</startTime><endTime>${utcStamp(o.end)}</endTime></timeSpan></timeSpanList>` +
    `<maxResults>${o.limit}</maxResults>` +
    // The NVR's own spelling.
    `<searchResultPostion>${o.position}</searchResultPostion>` +
    '<metadataList><metadataDescriptor>//recordType.meta.std-cgi.com</metadataDescriptor></metadataList>' +
    '</CMSearchDescription>'
  )
}

const STAMP = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,3}))?Z$/

/** Milliseconds since 1970 for a real UTC time written `yyyy-mm-ddThh:mm:ss[.fff]Z`, else null. */
function parseStamp(raw: string | null): number | null {
  const m = raw === null ? null : STAMP.exec(raw)
  if (!m) return null
  const [y, mo, d, h, mi, s] = m.slice(1, 7).map(Number)
  const ms = m[7] ? Number(m[7].padEnd(3, '0')) : 0
  if (y < 1970 || mo < 1 || mo > 12 || h > 23 || mi > 59 || s > 59) return null
  const t = Date.UTC(y, mo - 1, d, h, mi, s, ms)
  return new Date(t).getUTCDate() === d ? t : null // 30 February and the like roll over into the next month
}

type Page = { segments: Segment[]; more: boolean; /** items the NVR sent, usable or not: the next page starts after them */ count: number; /** the answer is a search result at all */ valid: boolean }

function sortedUnique(list: Segment[]): Segment[] {
  const seen = new Set<string>()
  const out: Segment[] = []
  for (const s of list) {
    const key = `${s.start.getTime()}|${s.end.getTime()}`
    if (seen.has(key)) continue
    seen.add(key)
    out.push(s)
  }
  return out.sort((a, b) => a.start.getTime() - b.start.getTime() || a.end.getTime() - b.end.getTime())
}

function parsePage(xml: string): Page {
  const items = elements(xml, 'searchMatchItem', MAX_SEGMENTS)
  const found: Segment[] = []
  for (const block of items) {
    const span = firstElement(block, 'timeSpan')
    if (span === null) continue
    const start = parseStamp(text(firstElement(span, 'startTime')))
    const end = parseStamp(text(firstElement(span, 'endTime')))
    if (start === null || end === null || end <= start) continue
    found.push({ start: new Date(start), end: new Date(end) })
  }
  const status = text(firstElement(xml, 'responseStatusStrg'))
  return { segments: sortedUnique(found), more: status !== null && status.toUpperCase() === 'MORE', count: items.length, valid: ascii(xml).includes('<cmsearchresult') }
}

/** The recordings listed in one answer (at most 5000), sorted by start, identical ones once, unusable ones left out; and whether the NVR says there are more. */
export function parseSearchResult(xml: string): { segments: Segment[]; more: boolean } {
  const { segments, more } = parsePage(xml)
  return { segments, more }
}

/** Days of the month (1 to 31) that the calendar marks as having recordings, ascending. */
export function parseDailyDistribution(xml: string): number[] {
  const days = new Set<number>()
  for (const block of elements(xml, 'day', 62)) {
    const day = text(firstElement(block, 'dayOfMonth'))
    const record = text(firstElement(block, 'record'))
    if (day === null || record === null || !/^\d{1,2}$/.test(day) || record.toLowerCase() !== 'true') continue
    const n = Number(day)
    if (n >= 1 && n <= 31) days.add(n)
  }
  return [...days].sort((a, b) => a - b)
}

const SEARCH_PATH = '/ISAPI/ContentMgmt/search'

/**
 * Every recording that touches the local day `day` (yyyy-mm-dd, as shown to people), with times as shown (NVR time + offsetMin).
 * Nothing is clipped to the day. Pages are read until the NVR stops saying MORE, a page brings nothing new, 50 pages have been read or
 * 5000 segments are held, all under one deadline. Wrong input is a plain Error; NVR trouble is an NvrError.
 */
export async function findSegments(client: NvrClient, o: { channel: number; day: string; offsetMin: number }): Promise<Segment[]> {
  const m = typeof o.day === 'string' ? /^(\d{4})-(\d{2})-(\d{2})$/.exec(o.day) : null
  if (!m || !isChannel(o.channel) || typeof o.offsetMin !== 'number' || !Number.isFinite(o.offsetMin) || Math.abs(o.offsetMin) > MAX_OFFSET_MIN) throw new Error(BAD_INPUT)
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])]
  if (y < 2000 || y > 2100 || mo < 1 || mo > 12 || d < 1 || new Date(Date.UTC(y, mo - 1, d)).getUTCDate() !== d) throw new Error(BAD_INPUT)
  const shift = o.offsetMin * 60_000
  const start = new Date(Date.UTC(y, mo - 1, d) - shift)
  const end = new Date(Date.UTC(y, mo - 1, d + 1) - shift)

  const signal = client.deadline()
  const searchId = randomUUID()
  let all: Segment[] = []
  let position = 0
  for (let page = 0; page < MAX_PAGES; page++) {
    const p = parsePage(await client.post(SEARCH_PATH, buildSearchBody({ channel: o.channel, start, end, position, limit: MAX_LIMIT, searchId }), signal))
    if (!p.valid) throw new NvrError('bad_response', 'no search result in the answer')
    const before = all.length
    all = sortedUnique([...all, ...p.segments])
    if (!p.more || p.count === 0 || all.length === before || all.length >= MAX_SEGMENTS) break
    position += p.count
  }
  return all.slice(0, MAX_SEGMENTS).map((s) => ({ start: new Date(s.start.getTime() + shift), end: new Date(s.end.getTime() + shift) }))
}

/** Days of the month (NVR calendar) on which camera `channel` has recordings, ascending. */
export async function recordedDays(client: NvrClient, o: { channel: number; year: number; month: number }): Promise<number[]> {
  if (!isChannel(o.channel) || !Number.isInteger(o.year) || o.year < 2000 || o.year > 2100 || !Number.isInteger(o.month) || o.month < 1 || o.month > 12) throw new Error(BAD_INPUT)
  const xml = await client.post(
    `/ISAPI/ContentMgmt/record/tracks/${o.channel}01/dailyDistribution`,
    `<trackDailyParam><year>${o.year}</year><monthOfYear>${o.month}</monthOfYear></trackDailyParam>`,
  )
  if (!ascii(xml).includes('<trackdailydistribution')) throw new NvrError('bad_response', 'no calendar in the answer')
  const length = new Date(Date.UTC(o.year, o.month, 0)).getUTCDate()
  return parseDailyDistribution(xml).filter((d) => d <= length)
}
