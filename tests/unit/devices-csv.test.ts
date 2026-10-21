import { describe, expect, it } from 'vitest'
import { parseDevicesCsv } from '@/lib/import/devices-csv'

describe('parseDevicesCsv', () => {
  it('reads devices with and without a store and a port', () => {
    const { rows, errors } = parseDevicesCsv('name,type,store_code,ip,port,notes\nERP server,Server,mdb,192.0.2.20,443,main\nDoor reader,attendance,,192.0.2.21,,\n')
    expect(errors).toEqual([])
    expect(rows).toEqual([
      { line: 2, name: 'ERP server', type: 'server', store_code: 'MDB', ip: '192.0.2.20', tcp_port: 443, notes: 'main' },
      { line: 3, name: 'Door reader', type: 'attendance', store_code: null, ip: '192.0.2.21', tcp_port: null, notes: null },
    ])
  })
  it('reports unknown types, bad addresses and bad ports with their line numbers', () => {
    const csv = ['name,type,ip,port', 'A,toaster,192.0.2.1,', 'B,server,999.1.1.1,', 'C,server,192.0.2.3,0', 'D,server,192.0.2.4,80'].join('\n')
    const { rows, errors } = parseDevicesCsv(csv)
    expect(rows.map((r) => r.name)).toEqual(['D'])
    expect(errors.map((e) => e.line)).toEqual([2, 3, 4])
  })
  it('refuses a file without the required columns', () => {
    expect(parseDevicesCsv('name,ip\nA,192.0.2.1\n').errors[0].message).toContain('name, type and ip')
  })
})
