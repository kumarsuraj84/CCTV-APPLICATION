import { describe, expect, it } from 'vitest'
import { parseStoresCsv } from '@/lib/import/stores-csv'

const HEADER = 'name,city,zone,ip,port,http_port,user,password,channels'

describe('parseStoresCsv', () => {
  it('reads the legacy columns as a location and its primary recorder with its channels (P2-5b), and fills defaults', () => {
    const { rows, errors } = parseStoresCsv(`${HEADER}\nStore 001 - Patna,Patna,br,192.0.2.10,,,viewer,pw1,16\n`)
    expect(errors).toEqual([])
    expect(rows).toEqual([{
      line: 2, code: 'STORE 001 - PATNA', name: 'Store 001 - Patna', city: 'Patna', zone: 'BR', state: null, address: null,
      recorder: { host: '192.0.2.10', rtsp_port: 554, http_port: 80, username: 'viewer', password: 'pw1', channels: 16 },
    }])
  })

  it('uses an explicit code in capitals', () => {
    const { rows } = parseStoresCsv('code,name,ip,user\nmdb,Madhubani,192.0.2.11,viewer\n')
    expect(rows[0].code).toBe('MDB')
  })

  it('reports each bad row with its line number and keeps the good ones', () => {
    const csv = [`${HEADER}`, 'A,c,z,not-an-ip,,,u,p,4', 'B,c,z,192.0.2.1,70000,,u,p,4', 'C,c,z,192.0.2.2,,,,p,4', 'D,c,z,192.0.2.3,,,u,p,4'].join('\n')
    const { rows, errors } = parseStoresCsv(csv)
    expect(rows.map((r) => r.name)).toEqual(['D'])
    expect(errors.map((e) => e.line)).toEqual([2, 3, 4])
  })

  it('reports a repeated code on the later line', () => {
    const { rows, errors } = parseStoresCsv('code,name,ip,user\nA1,One,192.0.2.1,u\nA1,Two,192.0.2.2,u\n')
    expect(rows).toHaveLength(1)
    expect(errors).toEqual([{ line: 3, message: 'The location code A1 appears more than once in this file.' }])
  })

  it('refuses a file without the required columns', () => {
    const { rows, errors } = parseStoresCsv('name,city\nA,B\n')
    expect(rows).toEqual([])
    expect(errors[0].message).toContain('name, ip and user')
  })
})
