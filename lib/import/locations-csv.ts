import { firstFilled, parseCsvStrict } from '@/lib/import/csv'
import { normalizeZone } from '@/lib/import/regions'
import { isValidIp, parsePort } from '@/lib/import/validators'
import { isLocationKind, normaliseCode, type LocationKind } from '@/lib/inventory/forms'

// The location CSV of the validated import (P2-5c-2 brief item 1; docs/drishti/admin-guide-import.md). It extends the legacy store file
// (name, city, zone, ip, port, http_port, user, password, channels — still read as "location + primary NVR + channels") with optional
// columns: code, display_name, kind, region, cluster, state, address, nvr_name, monitoring. A location with several NVRs is given as
// repeated rows with the same code (one row per NVR); a row without an NVR address is a location without an NVR (a head office).
//
// Review round 1:
//   B-I1  A row is read whole or not at all: the strict reader (RFC 4180 quotes) and a cell count equal to the first line's; a row
//         with a stray quote or another number of cells is a problem of that row, never merged with the next one, never shifted.
//         A quote that is never closed stops the file (`fatal`): nothing can be imported, also with "skip bad rows". A line break
//         inside a value is refused (every column is one line).
//   B-I2  A message names the column and the problem — never a cell value (a password must never be echoed, whatever lands where).
//   B-M2  An empty port cell is "not given" (null): an existing NVR keeps its ports, a new one gets 554 / 80.
//   B-M7  A file that was not decoded as UTF-8 (U+FFFD inside) is refused whole: a password would be saved wrong.
//   B-M8  A text value starting with =, +, - or @ is refused (spreadsheet formula); passwords and user names are not text values.
// Passwords are kept only in the parsed rows (for the vault).

export const MAX_IMPORT_ROWS = 5000

export type ImportIssue = { line: number; column?: string; message: string }

/** One NVR of a location, as one row of the file. Null: not given (an existing NVR keeps what is saved). */
export type RecorderRow = {
  line: number; host: string; rtsp_port: number | null; http_port: number | null; username: string
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
  /** Release 1 (T-1 review I1): lines swallowed by a quoted value that ran over several lines (each also listed as a problem). */
  linesNotRead: number
  /** Whether the file has an NVR address column at all (a file without one does not speak about NVRs). */
  listsRecorders: boolean
  /** The file cannot be read as a whole (an unclosed quote, not UTF-8): nothing may be imported, whatever is chosen. */
  fatal?: true
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
  // T-1: the location code column may be called location_code; the older store_code keeps working.
  location_code: 'code', store_code: 'code',
}
const KIND_WORDS: Record<string, LocationKind> = {
  store: 'store', shop: 'store', 'head office': 'head_office', head_office: 'head_office', ho: 'head_office', office: 'head_office',
  dc: 'dc', 'distribution centre': 'dc', 'distribution center': 'dc', warehouse: 'warehouse', other: 'other',
}
/** Columns whose value is free text people (and spreadsheets) read: a leading formula sign is refused (B-M8). */
const TEXT_COLUMNS = ['display_name', 'city', 'zone', 'state', 'address', 'nvr_name'] as const
const FORMULA = /^[=+\-@]/

export const MSG_CELL_COUNT = (n: number, header: number) =>
  `This row has ${n} cells; the first line has ${header}. Nothing of this row is read: check for a comma inside a value that is not in quotes.`
export const MSG_STRAY_QUOTE = 'A quote (") in the middle of a value: put the whole value in quotes and write a quote inside it twice (""). Nothing of this row is read.'
export const MSG_UNCLOSED_QUOTE = 'A quote (") opened on this line is never closed, so nothing from this line on can be read. Close it, then check the file again.'
export const MSG_NOT_UTF8 = 'The file is not saved as UTF-8 text (some characters cannot be read). Save it as “CSV UTF-8” and choose it again.'
export const MSG_SWALLOWED = (n: number, opened: number, closed: number) =>
  `Line ${n} is part of a value that was opened on line ${opened} and closed on line ${closed}, so it is not read as a row of its own.`
const MSG_FORMULA = 'Starts with =, +, - or @ (a spreadsheet would read it as a formula): remove that sign.'
const MSG_LINE_BREAK = 'A line break inside the value: put it on one line.'

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
    if (!c) fail('code', 'Not a location code: use letters, numbers and dashes, up to 50 (for example JCL).')
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
  fail('monitoring', 'Use yes or no.')
  return null
}

const LOCATION_FIELDS = [
  ['displayName', 'display_name', 'display name'], ['kind', 'kind', 'kind'], ['city', 'city', 'city'], ['zone', 'zone', 'zone'],
  ['state', 'state', 'state'], ['address', 'address', 'address'], ['region', 'region', 'region'], ['cluster', 'cluster', 'cluster'],
] as const

export function parseLocationsCsv(text: string): ParsedLocations {
  const out: ParsedLocations = { groups: [], errors: [], warnings: [], badCodes: [], bad: [], rows: 0, linesNotRead: 0, listsRecorders: false }
  const fatal = (line: number, message: string) => {
    out.errors.push({ line, message })
    out.fatal = true
    return out
  }
  if (text.includes('�')) return fatal(1, MSG_NOT_UTF8)
  const { rows: raw, unclosedAt } = parseCsvStrict(text)
  if (raw.length === 0 && unclosedAt === undefined) {
    out.errors.push({ line: 1, message: 'The file is empty.' })
    return out
  }
  if (unclosedAt !== undefined) return fatal(unclosedAt, MSG_UNCLOSED_QUOTE)
  if (raw[0].problem || raw[0].multiline) return fatal(1, 'The first line cannot be read: it must be the column names, separated by commas.')
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
    if (h.trim() !== '' && !KNOWN.has(headers[i])) out.warnings.push({ line: 1, column: h.trim(), message: 'This column is not used.' })
  })
  out.listsRecorders = headers.includes('ip')
  const columnsOf = (key: string) => headers.flatMap((h, i) => (h === key ? [i] : []))
  const codeAt = columnsOf('code')
  const nameAt = columnsOf('name')
  const byCode = new Map<string, LocationGroup>()
  const bad = new Set<string>()
  const markBad = (code: string | null, line: number) => {
    if (!code) return
    if (!bad.has(code)) out.bad.push({ code, line: byCode.get(code)?.line ?? line })
    bad.add(code)
  }
  /** NVR address + web port → the line and location that gave it first. */
  const addresses = new Map<string, { line: number; code: string }>()
  /** Which line first gave a location field (for the "contradicts line N" message). */
  const firstLines = new Map<string, number>()
  const firstLineWith = (group: LocationGroup, key: string) => firstLines.get(`${group.code}|${key}`) ?? group.line

  for (const row of raw.slice(1)) {
    const { line, cells } = row
    out.rows++
    // B-I1: a row that cannot be read exactly is not read at all. Its location (by the code cell, when that can be told) is skipped
    // whole in "skip bad rows".
    const roughCode = (() => {
      const c = codeAt.map((i) => cell(cells[i])).find((x) => x !== '') ?? ''
      if (c !== '') return normaliseCode(c)
      const n = nameAt.map((i) => cell(cells[i]).replace(/\s+/g, ' ').toUpperCase()).find((x) => x !== '') ?? ''
      return n !== '' && n.length <= 50 ? n : null
    })()
    // T-1 (re-review N1): a quoted value that runs over several lines swallowed the lines after the first. Each is named, so that
    // "skip the rows with problems" never drops a location without saying so. (They cannot be read as rows: nothing is guessed.)
    if (row.lastLine !== undefined) {
      for (let n = line + 1; n <= row.lastLine; n++) out.errors.push({ line: n, message: MSG_SWALLOWED(n, line, row.lastLine) })
      out.linesNotRead += row.lastLine - line
    }
    if (row.problem === 'stray_quote') {
      out.errors.push({ line, message: MSG_STRAY_QUOTE })
      markBad(roughCode, line)
      continue
    }
    if (cells.length !== headers.length) {
      out.errors.push({ line, message: MSG_CELL_COUNT(cells.length, headers.length) })
      markBad(roughCode, line)
      continue
    }
    if (row.multiline?.length) {
      for (const at of row.multiline) out.errors.push({ line, column: raw[0].cells[at]?.trim() || headers[at], message: MSG_LINE_BREAK })
      markBad(roughCode, line)
      continue
    }
    // Release 1 (T-1 review L4): the first repeated or aliased column with a value wins (code / location_code / store_code too).
    const v = firstFilled(headers, cells, (h) => KNOWN.has(h))
    let failed = false
    const fail: Fail = (column, message) => {
      failed = true
      out.errors.push({ line, ...(column ? { column } : {}), message })
    }
    const code = readCode(v, fail)
    for (const col of TEXT_COLUMNS) if (FORMULA.test(cell(v[col]))) fail(col, MSG_FORMULA)

    // Location columns.
    const kindText = cell(v.kind)
    let kind: LocationKind | null = null
    if (kindText !== '') {
      const k = KIND_WORDS[kindText.toLowerCase()] ?? (isLocationKind(kindText.toLowerCase()) ? (kindText.toLowerCase() as LocationKind) : null)
      if (!k) fail('kind', 'Not a kind of location: use store, head office, DC, warehouse or other.')
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
    if (regionText !== '' && !region) fail('region', 'Not a region code: use letters, numbers and dashes, up to 50.')
    else if (region && clusterText === '') fail('region', 'A location joins a region through its cluster: give a cluster too, or leave the region empty.')
    if (clusterText !== '' && !cluster) fail('cluster', 'Not a cluster code: use letters, numbers and dashes, up to 50.')

    // NVR columns: a row without an address is a location without an NVR.
    let recorder: RecorderRow | null = null
    const ip = cell(v.ip)
    if (ip !== '') {
      if (!isValidIp(ip)) fail('ip', 'Not a valid IP address.')
      const rtsp = cell(v.port) === '' ? null : parsePort(v.port ?? '', null)
      const http = cell(v.http_port) === '' ? null : parsePort(v.http_port ?? '', null)
      if (cell(v.port) !== '' && rtsp === null) fail('port', 'The video (RTSP) port must be a whole number from 1 to 65535.')
      if (cell(v.http_port) !== '' && http === null) fail('http_port', 'The web (HTTP) port must be a whole number from 1 to 65535.')
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
      recorder = { line, host: ip, rtsp_port: rtsp, http_port: http, username: user, password, channels, name, monitoring }
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
          fail(column, `Line ${firstLineWith(group, key)} gives this location another ${what}; a later row of the same location must give the same or leave it empty.`)
        }
      }
    }
    if (recorder) {
      // An empty web port is 80 for the purpose of "the same NVR twice" in one file.
      const key = `${recorder.host.toLowerCase()}|${recorder.http_port ?? 80}`
      const same = group.recorders.find((r) => `${r.host.toLowerCase()}|${r.http_port ?? 80}` === key)
      if (same) fail('ip', `Line ${same.line} already gives this location an NVR at the same address and web port.`)
      else {
        const elsewhere = addresses.get(key)
        if (elsewhere && elsewhere.code !== code) {
          out.warnings.push({ line, column: 'ip', message: `Line ${elsewhere.line} gives another location an NVR at the same address and web port. Check that it is right.` })
        } else if (!elsewhere) addresses.set(key, { line, code })
      }
    }
    if (failed) {
      markBad(code, line)
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
