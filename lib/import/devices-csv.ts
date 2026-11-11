import { firstFilled, parseCsvStrict } from '@/lib/import/csv'
import { MSG_CELL_COUNT, MSG_NOT_UTF8, MSG_STRAY_QUOTE, MSG_UNCLOSED_QUOTE } from '@/lib/import/locations-csv'
import { isValidIp, parsePort } from '@/lib/import/validators'
import { DEVICE_TYPES, type DeviceType } from '@/lib/inventory/device-types'

// The device CSV of the Import page. Final fix Y (final review C I-8, M-18, M-30): the same strict reading as the location import
// (lib/import/locations-csv.ts, review B-I1/I2/M7/M8 of P2-5c-2): RFC 4180 quotes, a row read whole or not at all (cell count, stray
// quote), a quote never closed stops the file, UTF-8 only, no spreadsheet formula at the start of a text; every message names the column
// and never repeats a cell value. An empty location or notes cell KEEPS what is saved; the clear token empties it on purpose. The rows
// are applied by the database in one transaction (inventory_devices_import, migration 20261021000049): all of them or none.

export const CLEAR_TOKEN = '(clear)'
export const MAX_DEVICE_ROWS = 5000

export type DeviceRow = {
  line: number
  name: string
  type: DeviceType
  /** Null: keep the saved location (or none for a new device). */
  location_code: string | null
  clear_location: boolean
  ip: string
  tcp_port: number | null
  /** Null: keep the saved notes. */
  notes: string | null
  clear_notes: boolean
}
export type DeviceIssue = { line: number; column?: string; message: string }
export type ParsedDevices = { rows: DeviceRow[]; errors: DeviceIssue[]; warnings: DeviceIssue[]; fatal?: true }

const ALIASES: Record<string, string> = { store_code: 'location_code', location: 'location_code', code: 'location_code', tcp_port: 'port', address: 'ip' }
const KNOWN = new Set(['name', 'type', 'location_code', 'ip', 'port', 'notes'])
const FORMULA = /^[=+\-@]/
const MSG_FORMULA = 'Starts with =, +, - or @ (a spreadsheet would read it as a formula): remove that sign.'
export const MSG_REPEATED_COLUMN = 'This column is given more than once (or also under an older name): in each row the first one with a value is used.'

const headerKey = (h: string) => {
  const k = h.trim().toLowerCase().replace(/[\s-]+/g, '_')
  return ALIASES[k] ?? k
}
const cell = (v: string | undefined) => (v ?? '').trim()

export function parseDevicesCsv(text: string): ParsedDevices {
  const out: ParsedDevices = { rows: [], errors: [], warnings: [] }
  const fatal = (line: number, message: string) => {
    out.errors.push({ line, message })
    out.fatal = true
    return out
  }
  if (text.includes('�')) return fatal(1, MSG_NOT_UTF8)
  const { rows: raw, unclosedAt } = parseCsvStrict(text)
  if (unclosedAt !== undefined) return fatal(unclosedAt, MSG_UNCLOSED_QUOTE)
  if (raw.length === 0) {
    out.errors.push({ line: 1, message: 'The file is empty.' })
    return out
  }
  if (raw[0].problem || raw[0].multiline) return fatal(1, 'The first line cannot be read: it must be the column names, separated by commas.')
  const headers = raw[0].cells.map(headerKey)
  if (!['name', 'type', 'ip'].every((h) => headers.includes(h))) {
    out.errors.push({ line: 1, message: 'The first line must have the columns name, type and ip (see the sample file).' })
    return out
  }
  if (raw.length - 1 > MAX_DEVICE_ROWS) {
    out.errors.push({ line: 1, message: `The file has more than ${MAX_DEVICE_ROWS} rows. Split it into smaller files.` })
    return out
  }
  for (const key of KNOWN) if (headers.filter((h) => h === key).length > 1) out.warnings.push({ line: 1, column: key, message: MSG_REPEATED_COLUMN })
  raw[0].cells.forEach((h, i) => {
    if (h.trim() !== '' && !KNOWN.has(headers[i])) out.warnings.push({ line: 1, column: h.trim().slice(0, 40), message: 'This column is not used.' })
  })
  const seen = new Map<string, number>()
  for (const row of raw.slice(1)) {
    const { line, cells } = row
    if (row.problem === 'stray_quote') {
      out.errors.push({ line, message: MSG_STRAY_QUOTE })
      continue
    }
    if (cells.length !== headers.length) {
      out.errors.push({ line, message: MSG_CELL_COUNT(cells.length, headers.length) })
      continue
    }
    if (row.multiline?.length) {
      out.errors.push({ line, message: 'A line break inside a value: put every value on one line.' })
      continue
    }
    const v = firstFilled(headers, cells, (h) => KNOWN.has(h))
    const fail = (column: string, message: string) => out.errors.push({ line, column, message })
    const name = cell(v.name)
    if (!name) { fail('name', 'The device name is empty.'); continue }
    if (name.length > 200) { fail('name', 'The device name is too long (at most 200 characters).'); continue }
    if (FORMULA.test(name)) { fail('name', MSG_FORMULA); continue }
    const type = cell(v.type).toLowerCase()
    if (!(DEVICE_TYPES as readonly string[]).includes(type)) { fail('type', `Not a device type: use ${DEVICE_TYPES.join(', ')}.`); continue }
    const ip = cell(v.ip)
    if (!isValidIp(ip)) { fail('ip', 'Not a valid IP address.'); continue }
    const portText = cell(v.port)
    const port = portText === '' ? null : parsePort(portText, null)
    if (portText !== '' && port === null) { fail('port', 'The port must be a whole number from 1 to 65535.'); continue }
    const codeText = cell(v.location_code)
    const clearLocation = codeText.toLowerCase() === CLEAR_TOKEN
    if (!clearLocation && codeText !== '' && (codeText.length > 50 || FORMULA.test(codeText))) { fail('location_code', 'Not a location code: letters, numbers and dashes, up to 50.'); continue }
    const notesText = cell(v.notes)
    const clearNotes = notesText.toLowerCase() === CLEAR_TOKEN
    if (!clearNotes && notesText.length > 500) { fail('notes', 'The notes are too long (at most 500 characters).'); continue }
    if (!clearNotes && FORMULA.test(notesText)) { fail('notes', MSG_FORMULA); continue }
    const key = `${ip.toLowerCase()}|${port ?? ''}`
    const first = seen.get(key)
    if (first !== undefined) { fail('ip', `Line ${first} already gives a device at the same address and port.`); continue }
    seen.set(key, line)
    out.rows.push({
      line, name, type: type as DeviceType,
      location_code: clearLocation || codeText === '' ? null : codeText.toUpperCase(), clear_location: clearLocation,
      ip, tcp_port: port,
      notes: clearNotes || notesText === '' ? null : notesText, clear_notes: clearNotes,
    })
  }
  out.errors.sort((a, b) => a.line - b.line)
  return out
}
