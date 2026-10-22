import { parseCsv } from '@/lib/import/csv'
import { normalizeZone } from '@/lib/import/regions'
import { isValidIp, parsePort } from '@/lib/import/validators'
import { isLocationKind, normaliseCode, type LocationKind } from '@/lib/inventory/forms'

// The location CSV of the validated import (P2-5c-2 brief item 1; docs/drishti/admin-guide-import.md). It extends the legacy store file
// (name, city, zone, ip, port, http_port, user, password, channels — still read as "location + primary NVR + channels") with optional
// columns: code, display_name, kind, region, cluster, state, address, nvr_name, monitoring. A location with several NVRs is given as
// repeated rows with the same code (one row per NVR); a row without an NVR address is a location without an NVR (a head office).
// Every problem names its line, its column and a plain reason. Passwords are kept only in the parsed rows (for the vault); they never
// appear in a problem message or a warning.

export const MAX_IMPORT_ROWS = 5000

export type ImportIssue = { line: number; column?: string; message: string }

/** One NVR of a location, as one row of the file. `channels` null: not given (an existing NVR keeps its number). */
export type RecorderRow = {
  line: number; host: string; rtsp_port: number; http_port: number; username: string
  /** Write-only: goes to the vault; empty keeps the saved one. */
  password: string
  channels: number | null; name: string | null
  /** null: not given (a new NVR is switched on, an existing one keeps its switch). */
  monitoring: boolean | null
}

/** One location of the file (its first row gives its line). Fields are null when the file does not give them. */
export type LocationGroup = {
  code: string; line: number; lines: number[]
  displayName: string | null; kind: LocationKind | null; city: string | null; zone: string | null; state: string | null; address: string | null
  region: string | null; cluster: string | null
  recorders: RecorderRow[]
}

export type ParsedLocations = {
  groups: LocationGroup[]
  errors: ImportIssue[]
  warnings: ImportIssue[]
  /** Codes of locations with at least one bad row ("skip bad rows" skips the whole location). */
  badCodes: string[]
  /** The same locations with the line of their first row. */
  bad: { code: string; line: number }[]
  /** Data rows read (header not counted). */
  rows: number
  /** Whether the file has an NVR address column at all (a file without one does not speak about NVRs). */
  listsRecorders: boolean
}

const KNOWN = new Set([
  'code', 'name', 'display_name', 'kind', 'city', 'zone', 'state', 'address', 'region', 'cluster',
  'ip', 'port', 'http_port', 'user', 'password', 'channels', 'nvr_name', 'monitoring',
])
/** Header spellings people use for the same column. */
const ALIASES: Record<string, string> = {
  displayname: 'display_name', display: 'display_name', location_name: 'display_name', type: 'kind', location_kind: 'kind',
  rtsp_port: 'port', video_port: 'port', web_port: 'http_port', httpport: 'http_port', username: 'user', nvr_user: 'user',
  nvr_password: 'password', cameras: 'channels', recorder_name: 'nvr_name', nvr: 'nvr_name', region_code: 'region', cluster_code: 'cluster',
  nvr_address: 'ip', host: 'ip', address_line: 'address',
}
const KIND_WORDS: Record<string, LocationKind> = {
  store: 'store', shop: 'store', 'head office': 'head_office', head_office: 'head_office', ho: 'head_office', office: 'head_office',
  dc: 'dc', 'distribution centre': 'dc', 'distribution center': 'dc', warehouse: 'warehouse', other: 'other',
}

const headerKey = (h: string) => {
  const k = h.trim().toLowerCase().replace(/[\s-]+/g, '_')
  return ALIASES[k] ?? k
}
const cell = (v: string | undefined) => (v ?? '').trim()
const orNull = (v: string | undefined) => (cell(v) === '' ? null : cell(v))

type Fail = (column: string | undefined, message: string) => void

/** The location code: the code column (letters, numbers and dashes), else the name column as the legacy file had it (upper case). */
function readCode(v: Record<string, string>, fail: Fail): string | null {
  const explicit = cell(v.code)
  if (explicit !== '') {
    const c = normaliseCode(explicit)
    if (!c) fail('code', `“${explicit}” is not a location code: use letters, numbers and dashes, up to 50 (for example JCL).`)
    return c
  }
  const name = cell(v.name).replace(/\s+/g, ' ').toUpperCase()
  if (name === '') {
    fail('code', 'Give the location code (or a name).')
    return null
  }
  if (name.length > 50 || !/^[A-Z0-9]/.test(name)) {
    fail('name', 'The name is used as the location code: it must start with a letter or number and have at most 50 characters. Add a code column.')
    return null
  }
  return name
}

function readText(v: Record<string, string>, key: string, max: number, fail: Fail, what: string): string | null {
  const t = orNull(v[key])
  if (t !== null && t.length > max) {
    fail(key, `The ${what} is too long (at most ${max} characters).`)
    return null
  }
  return t
}

function readMonitoring(raw: string, fail: Fail): boolean | null {
  const t = raw.trim().toLowerCase()
  if (t === '') return null
  if (['yes', 'y', 'on', 'true', '1'].includes(t)) return true
  if (['no', 'n', 'off', 'false', '0'].includes(t)) return false
  fail('monitoring', `“${raw.trim()}” is not yes or no.`)
  return null
}

const LOCATION_FIELDS = [
  ['displayName', 'display_name', 'display name'], ['kind', 'kind', 'kind'], ['city', 'city', 'city'], ['zone', 'zone', 'zone'],
  ['state', 'state', 'state'], ['address', 'address', 'address'], ['region', 'region', 'region'], ['cluster', 'cluster', 'cluster'],
] as const

export function parseLocationsCsv(text: string): ParsedLocations {
  const out: ParsedLocations = { groups: [], errors: [], warnings: [], badCodes: [], bad: [], rows: 0, listsRecorders: false }
  const raw = parseCsv(text)
  if (raw.length === 0) {
    out.errors.push({ line: 1, message: 'The file is empty.' })
    return out
  }
  const headers = raw[0].cells.map(headerKey)
  if (!headers.includes('code') && !headers.includes('name')) {
    out.errors.push({ line: 1, message: 'The first line must have a code or a name column (see the sample file).' })
    return out
  }
  if (raw.length - 1 > MAX_IMPORT_ROWS) {
    out.errors.push({ line: 1, message: `The file has more than ${MAX_IMPORT_ROWS} rows. Split it into smaller files.` })
    return out
  }
  raw[0].cells.forEach((h, i) => {
    if (h.trim() !== '' && !KNOWN.has(headers[i])) out.warnings.push({ line: 1, column: h.trim(), message: `The column “${h.trim()}” is not used.` })
  })
  out.listsRecorders = headers.includes('ip')
  const byCode = new Map<string, LocationGroup>()
  const bad = new Set<string>()
  /** NVR address + web port → the line and location that gave it first. */
  const addresses = new Map<string, { line: number; code: string }>()
  /** Which line first gave a location field (for the "contradicts line N" message). */
  const firstLines = new Map<string, number>()
  const firstLineWith = (group: LocationGroup, key: string) => firstLines.get(`${group.code}|${key}`) ?? group.line

  for (const { line, cells } of raw.slice(1)) {
    out.rows++
    const v: Record<string, string> = {}
    headers.forEach((h, i) => {
      if (KNOWN.has(h) && v[h] === undefined) v[h] = cells[i] ?? ''
    })
    let failed = false
    const fail: Fail = (column, message) => {
      failed = true
      out.errors.push({ line, ...(column ? { column } : {}), message })
    }
    const code = readCode(v, fail)

    // Location columns.
    const kindText = cell(v.kind)
    let kind: LocationKind | null = null
    if (kindText !== '') {
      const k = KIND_WORDS[kindText.toLowerCase()] ?? (isLocationKind(kindText.toLowerCase()) ? (kindText.toLowerCase() as LocationKind) : null)
      if (!k) fail('kind', `“${kindText}” is not a kind of location. Use store, head office, DC, warehouse or other.`)
      kind = k
    }
    const displayName = readText(v, 'display_name', 200, fail, 'display name')
    const city = readText(v, 'city', 200, fail, 'city')
    const zoneText = readText(v, 'zone', 200, fail, 'zone')
    const stateText = readText(v, 'state', 200, fail, 'state')
    const address = readText(v, 'address', 500, fail, 'address')
    const regionText = cell(v.region)
    const clusterText = cell(v.cluster)
    const region = regionText === '' ? null : normaliseCode(regionText)
    const cluster = clusterText === '' ? null : normaliseCode(clusterText)
    if (regionText !== '' && !region) fail('region', `“${regionText}” is not a region code: use letters, numbers and dashes, up to 50.`)
    else if (region && clusterText === '') fail('region', 'A location joins a region through its cluster: give a cluster too, or leave the region empty.')
    if (clusterText !== '' && !cluster) fail('cluster', `“${clusterText}” is not a cluster code: use letters, numbers and dashes, up to 50.`)

    // NVR columns: a row without an address is a location without an NVR.
    let recorder: RecorderRow | null = null
    const ip = cell(v.ip)
    if (ip !== '') {
      if (!isValidIp(ip)) fail('ip', `“${ip}” is not a valid IP address.`)
      const rtsp = parsePort(v.port ?? '', 554)
      const http = parsePort(v.http_port ?? '', 80)
      if (rtsp === null) fail('port', 'The video (RTSP) port must be a whole number from 1 to 65535.')
      if (http === null) fail('http_port', 'The web (HTTP) port must be a whole number from 1 to 65535.')
      const user = cell(v.user)
      if (user === '') fail('user', 'Give the NVR user name (the row has an NVR address).')
      else if (user.length > 200) fail('user', 'The NVR user name is too long (at most 200 characters).')
      const password = v.password ?? ''
      if (password.length > 200) fail('password', 'The password is too long (at most 200 characters).')
      const channelsText = cell(v.channels)
      let channels: number | null = null
      if (channelsText !== '') {
        if (!/^\d{1,3}$/.test(channelsText)) fail('channels', 'The number of cameras must be a whole number from 0 to 999.')
        else channels = Number(channelsText)
      }
      const name = readText(v, 'nvr_name', 200, fail, 'NVR name')
      const monitoring = readMonitoring(v.monitoring ?? '', fail)
      if (rtsp !== null && http !== null) recorder = { line, host: ip, rtsp_port: rtsp, http_port: http, username: user, password, channels, name, monitoring }
    } else if (cell(v.user) !== '' || cell(v.password) !== '' || cell(v.channels) !== '' || cell(v.nvr_name) !== '') {
      fail('ip', 'Give the NVR address (the row has other NVR columns), or leave the NVR columns empty for a location without an NVR.')
    }

    if (!code) continue
    const values = { displayName, kind, city, zone: normalizeZone(zoneText), state: normalizeZone(stateText), address, region, cluster }
    let group = byCode.get(code)
    if (!group) {
      group = { code, line, lines: [], displayName: null, kind: null, city: null, zone: null, state: null, address: null, region: null, cluster: null, recorders: [] }
    } else {
      // A later row of the same location may leave the location columns empty, or repeat them; it may not contradict them.
      for (const [key, column, what] of LOCATION_FIELDS) {
        const now = values[key]
        const before = group[key]
        if (now !== null && before !== null && now !== before) {
          fail(column, `Line ${firstLineWith(group, key)} gives this location the ${what} “${before}”; a later row of the same location must give the same or leave it empty.`)
        }
      }
    }
    if (recorder) {
      const key = `${recorder.host.toLowerCase()}|${recorder.http_port}`
      const same = group.recorders.find((r) => `${r.host.toLowerCase()}|${r.http_port}` === key)
      if (same) fail('ip', `Line ${same.line} already gives this location an NVR at ${recorder.host} port ${recorder.http_port}.`)
      else {
        const elsewhere = addresses.get(key)
        if (elsewhere && elsewhere.code !== code) {
          out.warnings.push({ line, column: 'ip', message: `Line ${elsewhere.line} (location ${elsewhere.code}) has an NVR at the same address and port. Check that it is right.` })
        } else if (!elsewhere) addresses.set(key, { line, code })
      }
    }
    if (failed) {
      if (!bad.has(code)) out.bad.push({ code, line: byCode.get(code)?.line ?? line })
      bad.add(code)
      continue
    }
    if (!byCode.has(code)) {
      byCode.set(code, group)
      out.groups.push(group)
    }
    group.lines.push(line)
    for (const [key] of LOCATION_FIELDS) {
      const now = values[key]
      if (now !== null && group[key] === null) {
        ;(group as Record<string, unknown>)[key] = now
        firstLines.set(`${code}|${key}`, line)
      }
    }
    if (recorder) group.recorders.push(recorder)
  }
  out.badCodes = [...bad]
  // A location with a bad row is skipped whole (never half of its NVRs): it is not a group to import.
  out.groups = out.groups.filter((g) => !bad.has(g.code))
  out.errors.sort((a, b) => a.line - b.line)
  return out
}

