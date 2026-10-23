import { firstFilled, parseCsv, type RowError } from '@/lib/import/csv'
import { isValidIp, parsePort } from '@/lib/import/validators'
import { DEVICE_TYPES, type DeviceType } from '@/lib/inventory/device-types'

export type DeviceRow = {
  line: number
  name: string
  type: DeviceType
  store_code: string | null
  ip: string
  tcp_port: number | null
  notes: string | null
}

const orNull = (v: string | undefined) => (v && v.trim() !== '' ? v.trim() : null)

export function parseDevicesCsv(text: string): { rows: DeviceRow[]; errors: RowError[] } {
  const raw = parseCsv(text)
  if (raw.length === 0) return { rows: [], errors: [{ line: 1, message: 'The file is empty.' }] }
  // T-1: the column is location_code; the older store_code keeps working (the first of them that has a value is used).
  const headers = raw[0].cells.map((h) => { const k = h.trim().toLowerCase(); return k === 'store_code' ? 'location_code' : k })
  if (!['name', 'type', 'ip'].every((h) => headers.includes(h))) {
    return { rows: [], errors: [{ line: 1, message: 'The first line must have the columns name, type and ip (see the sample file).' }] }
  }
  const rows: DeviceRow[] = []
  const errors: RowError[] = []
  for (const { line, cells } of raw.slice(1)) {
    const v = firstFilled(headers, cells) // the first repeated or aliased column with a value wins (release 1, L4)
    const fail = (message: string) => errors.push({ line, message })
    const name = v.name.trim()
    if (!name) { fail('The device name is empty.'); continue }
    const type = v.type.trim().toLowerCase()
    if (!(DEVICE_TYPES as readonly string[]).includes(type)) { fail(`“${v.type.trim()}” is not a device type. Use ${DEVICE_TYPES.join(', ')}.`); continue }
    if (!isValidIp(v.ip)) { fail(`“${v.ip.trim()}” is not a valid IP address.`); continue }
    const port = parsePort(v.port ?? '', null)
    if (v.port && v.port.trim() !== '' && port === null) { fail('The port must be a number from 1 to 65535.'); continue }
    rows.push({
      line, name, type: type as DeviceType,
      store_code: orNull(v.location_code)?.toUpperCase() ?? null,
      ip: v.ip.trim(), tcp_port: port, notes: orNull(v.notes),
    })
  }
  return { rows, errors }
}
