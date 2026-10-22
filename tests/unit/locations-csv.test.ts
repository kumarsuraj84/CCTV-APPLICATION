import { describe, expect, it } from 'vitest'
import { MAX_IMPORT_ROWS, parseLocationsCsv } from '@/lib/import/locations-csv'

// P2-5c-2 brief item 1: the location CSV of the validated import (validate → preview → apply). Synthetic data only (ruling R-1): the
// addresses are TEST-NET (192.0.2.x, 198.51.100.x) and the passwords are made up for the test.
const LEGACY = 'name,city,zone,ip,port,http_port,user,password,channels'

describe('parseLocationsCsv: the legacy store columns keep working (location + primary NVR + channels)', () => {
  // Review B-M2 replaces "fills the default ports": an empty port cell is "not given" (null). A NEW NVR then gets 554 / 80 (planner);
  // an existing one keeps its saved ports (tests/unit/import-plan.test.ts "B-M2: …").
  it('reads one legacy row as one location with one NVR; empty port cells are "not given"', () => {
    const r = parseLocationsCsv(`${LEGACY}\nJCL,Jhansi,up,192.0.2.10,,,viewer,Pw-JCL-1,16\n`)
    expect(r.errors).toEqual([])
    expect(r.groups).toEqual([{
      code: 'JCL', line: 2, lines: [2], displayName: null, kind: null, city: 'Jhansi', zone: 'UP', state: null, address: null, region: null, cluster: null,
      recorders: [{ line: 2, host: '192.0.2.10', rtsp_port: null, http_port: null, username: 'viewer', password: 'Pw-JCL-1', channels: 16, name: null, monitoring: null }],
    }])
    expect(r.rows).toBe(1)
  })

  it('keeps a legacy name with spaces as the code (upper case), as the old import did', () => {
    const r = parseLocationsCsv(`${LEGACY}\nSample Store A,Patna,BR,192.0.2.10,554,80,viewer,pw,4\n`)
    expect(r.errors).toEqual([])
    expect(r.groups[0].code).toBe('SAMPLE STORE A')
  })

  it('an empty channels cell means "not given" (an existing NVR keeps its number), not zero', () => {
    const r = parseLocationsCsv(`${LEGACY}\nJCL,Jhansi,UP,192.0.2.10,,,viewer,,\n`)
    expect(r.groups[0].recorders[0]).toMatchObject({ channels: null, password: '' })
  })
})

describe('parseLocationsCsv: the optional columns', () => {
  it('reads code, display name, kind, region, cluster, address, state, NVR name and monitoring', () => {
    const csv = [
      'code,display_name,kind,region,cluster,name,city,state,address,ip,port,http_port,user,password,channels,nvr_name,monitoring',
      'hq1,Head office Patna,Head office,east,east-1,Head office,Patna,bihar,"Road 1, Patna",192.0.2.20,8554,8080,viewer,Pw-HQ,2,Ground floor,no',
    ].join('\n')
    const r = parseLocationsCsv(csv)
    expect(r.errors).toEqual([])
    expect(r.groups[0]).toMatchObject({
      code: 'HQ1', displayName: 'Head office Patna', kind: 'head_office', region: 'EAST', cluster: 'EAST-1', city: 'Patna', state: 'Bihar', address: 'Road 1, Patna',
      recorders: [{ host: '192.0.2.20', rtsp_port: 8554, http_port: 8080, name: 'Ground floor', monitoring: false, channels: 2 }],
    })
  })

  it('accepts the kind as a stored value or as its label', () => {
    const csv = ['code,kind', 'A1,store', 'A2,DC', 'A3,Distribution centre', 'A4,warehouse', 'A5,Other', 'A6,head_office'].join('\n')
    const r = parseLocationsCsv(csv)
    expect(r.errors).toEqual([])
    expect(r.groups.map((g) => g.kind)).toEqual(['store', 'dc', 'dc', 'warehouse', 'other', 'head_office'])
  })

  it('a row without an NVR address is a location without an NVR (a head office)', () => {
    const r = parseLocationsCsv('code,display_name,kind,city,ip,user,password,channels\nHO,Head office,head_office,Kolkata,,,,\n')
    expect(r.errors).toEqual([])
    expect(r.groups[0]).toMatchObject({ code: 'HO', kind: 'head_office', recorders: [] })
  })

  it('several NVRs of one location are repeated rows with the same code; later rows may leave the location columns empty', () => {
    const csv = [
      'code,city,zone,ip,http_port,user,password,channels,nvr_name',
      'PTN,Patna,BR,192.0.2.30,80,viewer,Pw-1,16,Ground floor',
      'PTN,,,192.0.2.31,80,viewer,Pw-2,8,First floor',
      'PTN,Patna,,192.0.2.30,8080,viewer,Pw-3,4,',
    ].join('\n')
    const r = parseLocationsCsv(csv)
    expect(r.errors).toEqual([])
    expect(r.groups).toHaveLength(1)
    expect(r.groups[0]).toMatchObject({ code: 'PTN', line: 2, lines: [2, 3, 4], city: 'Patna', zone: 'BR' })
    expect(r.groups[0].recorders.map((x) => [x.line, x.host, x.http_port, x.name])).toEqual([
      [2, '192.0.2.30', 80, 'Ground floor'], [3, '192.0.2.31', 80, 'First floor'], [4, '192.0.2.30', 8080, null],
    ])
  })
})

describe('the sample files (synthetic) read without problems', () => {
  it('locations-sample.csv: two stores (one with two NVRs) and a head office; the legacy stores-sample.csv too', async () => {
    const { readFileSync } = await import('node:fs')
    const r = parseLocationsCsv(readFileSync('public/samples/locations-sample.csv', 'utf8'))
    expect(r.errors).toEqual([])
    expect(r.warnings).toEqual([])
    expect(r.groups.map((g) => [g.code, g.recorders.length, g.cluster, g.region])).toEqual([['SMP1', 2, 'EAST-1', 'EAST'], ['SMP2', 1, 'EAST-1', 'EAST'], ['HO1', 0, null, null]])
    const legacy = parseLocationsCsv(readFileSync('public/samples/stores-sample.csv', 'utf8'))
    expect(legacy.errors).toEqual([])
    expect(legacy.groups.map((g) => g.recorders.length)).toEqual([1, 1])
  })
})

describe('parseLocationsCsv: every problem names its line, its column and a plain reason', () => {
  it('reports the column of each bad cell', () => {
    const csv = [
      'code,name,kind,ip,port,http_port,user,password,channels,monitoring,region,cluster',
      'A1,One,store,not-an-ip,,,u,secret-one,4,,,',
      'A2,Two,store,192.0.2.2,70000,,u,secret-two,4,,,',
      'A3,Three,store,192.0.2.3,,abc,u,secret-three,4,,,',
      'A4,Four,store,192.0.2.4,,,,secret-four,4,,,',
      'A5,Five,store,192.0.2.5,,,u,secret-five,1000,,,',
      'A6,Six,castle,192.0.2.6,,,u,secret-six,4,,,',
      'a b!,Seven,store,192.0.2.7,,,u,secret-seven,4,,,',
      'A8,Eight,store,192.0.2.8,,,u,secret-eight,4,maybe,,',
      'A9,Nine,store,192.0.2.9,,,u,secret-nine,4,,EAST,',
      'A10,Ten,store,192.0.2.10,,,u,secret-ten,4,,,bad code!',
      ',,store,192.0.2.11,,,u,secret-eleven,4,,,',
    ].join('\n')
    const r = parseLocationsCsv(csv)
    expect(r.groups).toEqual([])
    expect(r.errors.map((e) => [e.line, e.column])).toEqual([
      [2, 'ip'], [3, 'port'], [4, 'http_port'], [5, 'user'], [6, 'channels'], [7, 'kind'], [8, 'code'], [9, 'monitoring'], [10, 'region'], [11, 'cluster'], [12, 'code'],
    ])
    // Review B-I2: a message names the column and the problem only — never a cell value (a shifted row could put a password there).
    expect(r.errors.map((e) => e.message)).toEqual([
      'Not a valid IP address.',
      'The video (RTSP) port must be a whole number from 1 to 65535.',
      'The web (HTTP) port must be a whole number from 1 to 65535.',
      'Give the NVR user name (the row has an NVR address).',
      'The number of cameras must be a whole number from 0 to 999.',
      'Not a kind of location: use store, head office, DC, warehouse or other.',
      'Not a location code: use letters, numbers and dashes, up to 50 (for example JCL).',
      'Use yes or no.',
      'A location joins a region through its cluster: give a cluster too, or leave the region empty.',
      'Not a cluster code: use letters, numbers and dashes, up to 50.',
      'Give the location code (or a name).',
    ])
    expect(r.badCodes.sort()).toEqual(['A1', 'A10', 'A2', 'A3', 'A4', 'A5', 'A6', 'A8', 'A9'])
    for (const v of ['not-an-ip', '70000', 'abc', '1000', 'castle', 'a b!', 'maybe', 'EAST', 'bad code!', 'secret-']) expect(JSON.stringify(r.errors)).not.toContain(v)
  })

  it('a repeated row that contradicts the location of an earlier row is refused on that row and column (no value quoted)', () => {
    const r = parseLocationsCsv('code,city,ip,user,password\nPTN,Patna,192.0.2.30,u,p1\nPTN,Gaya,192.0.2.31,u,p2\n')
    expect(r.errors).toEqual([{ line: 3, column: 'city', message: 'Line 2 gives this location another city; a later row of the same location must give the same or leave it empty.' }])
    expect(r.badCodes).toEqual(['PTN'])
  })

  it('the same NVR twice in one location is refused on the later row (no value quoted)', () => {
    const r = parseLocationsCsv('code,ip,http_port,user,password\nPTN,192.0.2.30,80,u,p1\nPTN,192.0.2.30,80,u,p2\n')
    expect(r.errors).toEqual([{ line: 3, column: 'ip', message: 'Line 2 already gives this location an NVR at the same address and web port.' }])
  })

  it('the same NVR address at two locations is a warning (probably a typo), not an error', () => {
    const r = parseLocationsCsv('code,ip,user,password\nA1,192.0.2.30,u,p1\nA2,192.0.2.30,u,p2\n')
    expect(r.errors).toEqual([])
    expect(r.warnings).toEqual([{ line: 3, column: 'ip', message: 'Line 2 gives another location an NVR at the same address and web port. Check that it is right.' }])
  })

  it('the first line must name the location (code or name); unknown columns are reported as not used', () => {
    expect(parseLocationsCsv('city,ip\nPatna,192.0.2.1\n').errors).toEqual([{ line: 1, message: 'The first line must have a code or a name column (see the sample file).' }])
    const r = parseLocationsCsv('code,colour\nA1,blue\n')
    expect(r.errors).toEqual([])
    expect(r.warnings).toEqual([{ line: 1, column: 'colour', message: 'This column is not used.' }])
  })

  it('an empty file and an over-long file are refused', () => {
    expect(parseLocationsCsv('').errors).toEqual([{ line: 1, message: 'The file is empty.' }])
    const many = ['code', ...Array.from({ length: MAX_IMPORT_ROWS + 1 }, (_, i) => `L${i}`)].join('\n')
    expect(parseLocationsCsv(many).errors).toEqual([{ line: 1, message: `The file has more than ${MAX_IMPORT_ROWS} rows. Split it into smaller files.` }])
  })
})

// Review B-I1: a row is read whole or not at all — never merged with the next row, never with its cells shifted.
describe('parseLocationsCsv: quotes and cell counts (review B-I1, B-I2, B-M7, B-M8)', () => {
  const H = 'name,city,zone,ip,port,http_port,user,password,channels'

  it('a row with more or fewer cells than the first line is a problem of that row and nothing of it is read', () => {
    const r = parseLocationsCsv(`${H}\nA1,Patna,BR,192.0.2.1,554,80,viewer,FAKE-SECRET-1,4,extra\nA2,Ranchi,JH,192.0.2.2,554,80,viewer,FAKE-SECRET-2\nA3,Gaya,BR,192.0.2.3,554,80,viewer,FAKE-SECRET-3,4\n`)
    expect(r.errors).toEqual([
      { line: 2, message: 'This row has 10 cells; the first line has 9. Nothing of this row is read: check for a comma inside a value that is not in quotes.' },
      { line: 3, message: 'This row has 8 cells; the first line has 9. Nothing of this row is read: check for a comma inside a value that is not in quotes.' },
    ])
    expect(r.groups.map((g) => g.code)).toEqual(['A3'])
    expect(r.badCodes.sort()).toEqual(['A1', 'A2'])
    expect(r.rows).toBe(3)
  })

  it('a shifted row (an address with commas, not in quotes) never puts its password into a message or a field', () => {
    const csv = 'code,display_name,kind,city,zone,state,address,region,cluster,ip,port,http_port,user,password,channels,nvr_name,monitoring\n'
      + 'SMP1,,store,Patna,BR,Bihar,Shop 1, Station Rd, Patna, Bihar,EAST,EAST-1,192.0.2.10,554,80,viewer,FAKE-SECRET-123,16,Ground floor,yes\n'
    const r = parseLocationsCsv(csv)
    expect(r.groups).toEqual([])
    expect(r.errors.map((e) => e.line)).toEqual([2])
    expect(JSON.stringify(r.errors)).not.toContain('FAKE-SECRET-123')
    expect(JSON.stringify(r.warnings)).not.toContain('FAKE-SECRET-123')
  })

  it('a quote in the middle of a value is a problem of that row; the next rows are still read whole', () => {
    const r = parseLocationsCsv(`${H}\nA1,O"Brien,BR,192.0.2.1,554,80,viewer,p1,4\nA2,Ranchi,JH,192.0.2.2,554,80,viewer,p2,4\nA3,Y",BR,192.0.2.3,554,80,viewer,p3,4\nA4,Gaya,BR,192.0.2.4,554,80,viewer,p4,4\n`)
    expect(r.errors).toEqual([
      { line: 2, message: 'A quote (") in the middle of a value: put the whole value in quotes and write a quote inside it twice (""). Nothing of this row is read.' },
      { line: 4, message: 'A quote (") in the middle of a value: put the whole value in quotes and write a quote inside it twice (""). Nothing of this row is read.' },
    ])
    expect(r.groups.map((g) => [g.code, g.city, g.recorders[0].host])).toEqual([['A2', 'Ranchi', '192.0.2.2'], ['A4', 'Gaya', '192.0.2.4']])
  })

  it('a quote that is never closed stops the file: nothing can be imported (also with "skip bad rows")', () => {
    const r = parseLocationsCsv(`${H}\nB1,Patna,BR,192.0.2.1,554,80,viewer,p1,4\nB2,"Y,BR,192.0.2.2,554,80,viewer,p2,4\nB3,Gaya,BR,192.0.2.3,554,80,viewer,p3,4\n`)
    expect(r.fatal).toBe(true)
    expect(r.errors).toEqual([{ line: 3, message: 'A quote (") opened on this line is never closed, so nothing from this line on can be read. Close it, then check the file again.' }])
    expect(r.groups).toEqual([])
  })

  it('a line break inside a quoted value is refused (every column is one line)', () => {
    const r = parseLocationsCsv(`${H}\nC1,"Patna\nCity",BR,192.0.2.1,554,80,viewer,p1,4\n`)
    expect(r.errors).toEqual([{ line: 2, column: 'city', message: 'A line break inside the value: put it on one line.' }])
    expect(r.groups).toEqual([])
  })

  it('quoted values, doubled quotes, Windows line endings and a byte-order mark are read correctly', () => {
    const r = parseLocationsCsv(`﻿${H}\r\nD1,"Patna, ""City""",BR,192.0.2.1,554,80,viewer,"p,1",4\r\n`)
    expect(r.errors).toEqual([])
    expect(r.groups[0]).toMatchObject({ code: 'D1', city: 'Patna, "City"', recorders: [{ password: 'p,1', channels: 4 }] })
  })

  it('a file that is not UTF-8 text is refused whole (a password would be saved wrong)', () => {
    const r = parseLocationsCsv(`${H}\nE1,Caf�,BR,192.0.2.1,554,80,viewer,p�1,4\n`)
    expect(r.fatal).toBe(true)
    expect(r.errors).toEqual([{ line: 1, message: 'The file is not saved as UTF-8 text (some characters cannot be read). Save it as “CSV UTF-8” and choose it again.' }])
  })

  it('a text value starting with =, +, - or @ (a spreadsheet formula) is refused; a password may start with them', () => {
    const r = parseLocationsCsv('code,display_name,city,address,ip,user,password,nvr_name\nF1,=SUM(A1),Patna,+1 road,192.0.2.1,viewer,=p@ss,@NVR\n')
    expect(r.errors.map((e) => [e.line, e.column, e.message])).toEqual([
      [2, 'display_name', 'Starts with =, +, - or @ (a spreadsheet would read it as a formula): remove that sign.'],
      [2, 'address', 'Starts with =, +, - or @ (a spreadsheet would read it as a formula): remove that sign.'],
      [2, 'nvr_name', 'Starts with =, +, - or @ (a spreadsheet would read it as a formula): remove that sign.'],
    ])
  })
})
