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
  // T-1 (ruling T-1): the column is called location_code now; the older store_code keeps working. With both, the first one that has a value is used.
  it('the location code column is location_code; the older store_code is still read', () => {
    const modern = parseDevicesCsv('name,type,location_code,ip\nERP,server,mdb,192.0.2.20\n')
    const older = parseDevicesCsv('name,type,store_code,ip\nERP,server,mdb,192.0.2.20\n')
    expect(modern.errors).toEqual([])
    expect(modern.rows[0].store_code).toBe('MDB')
    expect(older.rows).toEqual(modern.rows)
    const both = parseDevicesCsv('name,type,location_code,store_code,ip\nA,server,,gaya,192.0.2.1\nB,server,patna,gaya,192.0.2.2\n')
    expect(both.rows.map((r) => r.store_code)).toEqual(['GAYA', 'PATNA'])
  })
  it('the sample file uses the new column name and reads without a problem', async () => {
    const { readFileSync } = await import('node:fs')
    const text = readFileSync('public/samples/devices-sample.csv', 'utf8')
    expect(text.split('\n')[0]).toBe('name,type,location_code,ip,port,notes')
    expect(parseDevicesCsv(text).errors).toEqual([])
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
