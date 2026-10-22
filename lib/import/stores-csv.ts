import { parseCsv } from '@/lib/import/csv'
import { normalizeZone } from '@/lib/import/regions'
import { isValidIp, parsePort } from '@/lib/import/validators'

export type RowError = { line: number; message: string }
export type StoreRow = {
  line: number
  code: string
  name: string
  city: string | null
  zone: string | null
  state: string | null
  address: string | null
  nvr_ip: string
  rtsp_port: number
  http_port: number
  nvr_username: string
  nvr_password: string
  channels: number
}

const orNull = (v: string | undefined) => (v && v.trim() !== '' ? v.trim() : null)

// Columns follow the legacy stores file: name, city, zone, ip, port, http_port, user, password, channels; plus optional code, state, address.
export function parseStoresCsv(text: string): { rows: StoreRow[]; errors: RowError[] } {
  const raw = parseCsv(text)
  if (raw.length === 0) return { rows: [], errors: [{ line: 1, message: 'The file is empty.' }] }
  const headers = raw[0].cells.map((h) => h.trim().toLowerCase())
  if (!['name', 'ip', 'user'].every((h) => headers.includes(h))) {
    return { rows: [], errors: [{ line: 1, message: 'The first line must have the columns name, ip and user (see the sample file).' }] }
  }
  const rows: StoreRow[] = []
  const errors: RowError[] = []
  const seen = new Set<string>()
  for (const { line, cells } of raw.slice(1)) {
    const v: Record<string, string> = {}
    headers.forEach((h, i) => (v[h] = cells[i] ?? ''))
    const fail = (message: string) => errors.push({ line, message })
    const name = v.name.trim()
    if (!name) { fail('The store name is empty.'); continue }
    if (!isValidIp(v.ip)) { fail(`“${v.ip.trim()}” is not a valid IP address.`); continue }
    const rtsp = parsePort(v.port ?? '', 554)
    const http = parsePort(v.http_port ?? '', 80)
    if (rtsp === null || http === null) { fail('A port must be a number from 1 to 65535.'); continue }
    if (!v.user.trim()) { fail('The NVR user name is empty.'); continue }
    const channelsText = (v.channels ?? '').trim()
    if (channelsText !== '' && !/^\d{1,3}$/.test(channelsText)) { fail('The number of channels must be a whole number up to 999.'); continue }
    const code = (v.code?.trim() || name).toUpperCase().slice(0, 50)
    if (seen.has(code)) { fail(`The store code ${code} appears more than once in this file.`); continue }
    seen.add(code)
    rows.push({
      line, code, name,
      city: orNull(v.city), zone: normalizeZone(v.zone), state: normalizeZone(v.state), address: orNull(v.address),
      nvr_ip: v.ip.trim(), rtsp_port: rtsp, http_port: http,
      nvr_username: v.user.trim(), nvr_password: v.password ?? '',
      channels: channelsText === '' ? 0 : Number(channelsText),
    })
  }
  return { rows, errors }
}
