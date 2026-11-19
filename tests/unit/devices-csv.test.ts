import { describe, expect, it } from 'vitest'
import { CLEAR_TOKEN, parseDevicesCsv } from '@/lib/import/devices-csv'

// The device CSV of the Import page. Final fix Y (final review C I-8 and M-18, M-30): the strict reader of the location import (RFC 4180
// quotes, a cell count equal to the first line's, a quote never closed stops the file, UTF-8 only, no spreadsheet formulas in text),
// messages that name the column and never repeat a cell value, an empty cell that keeps what is saved and an explicit clear token, the
// same address twice in one file refused, and a warning when a column is given twice (or under an older name).

describe('parseDevicesCsv', () => {
  it('reads devices with and without a location and a port; an empty cell means "keep what is saved"', () => {
    const { rows, errors } = parseDevicesCsv('name,type,location_code,ip,port,notes\nERP server,Server,mdb,192.0.2.20,443,main\nDoor reader,attendance,,192.0.2.21,,\n')
    expect(errors).toEqual([])
    expect(rows).toEqual([
      { line: 2, name: 'ERP server', type: 'server', location_code: 'MDB', clear_location: false, ip: '192.0.2.20', tcp_port: 443, notes: 'main', clear_notes: false },
      { line: 3, name: 'Door reader', type: 'attendance', location_code: null, clear_location: false, ip: '192.0.2.21', tcp_port: null, notes: null, clear_notes: false },
    ])
  })

  it(`the clear token (${CLEAR_TOKEN}) empties the location or the notes on purpose`, () => {
    const { rows, errors } = parseDevicesCsv(`name,type,location_code,ip,notes\nERP,server,${CLEAR_TOKEN},192.0.2.20,(CLEAR)\n`)
    expect(errors).toEqual([])
    expect(rows[0]).toMatchObject({ location_code: null, clear_location: true, notes: null, clear_notes: true })
  })

  it('the location code column is location_code; the older store_code is still read, with a warning when both are given', () => {
    const modern = parseDevicesCsv('name,type,location_code,ip\nERP,server,mdb,192.0.2.20\n')
    const older = parseDevicesCsv('name,type,store_code,ip\nERP,server,mdb,192.0.2.20\n')
    expect(modern.errors).toEqual([])
    expect(modern.rows[0].location_code).toBe('MDB')
    expect(older.rows).toEqual(modern.rows)
    const both = parseDevicesCsv('name,type,location_code,store_code,ip\nA,server,,gaya,192.0.2.1\nB,server,patna,gaya,192.0.2.2\n')
    expect(both.rows.map((r) => r.location_code)).toEqual(['GAYA', 'PATNA'])
    expect(both.warnings).toEqual([{ line: 1, column: 'location_code', message: 'This column is given more than once (or also under an older name): in each row the first one with a value is used.' }])
  })

  it('a row with a stray quote or another number of cells is not read at all; an unclosed quote stops the file', () => {
    const r = parseDevicesCsv('name,type,ip\nA,server,192.0.2.1\nB "x",server,192.0.2.2\nC,server,192.0.2.3,extra\nD,server,192.0.2.4\n')
    expect(r.rows.map((x) => x.name)).toEqual(['A', 'D'])
    expect(r.errors.map((e) => e.line)).toEqual([3, 4])
    const open = parseDevicesCsv('name,type,ip\nA,server,192.0.2.1\n"B,server,192.0.2.2\n')
    expect(open.fatal).toBe(true)
    expect(open.rows).toEqual([])
  })

  it('no message repeats a cell value; formulas, bad types, addresses and ports are named by column and line', () => {
    const csv = ['name,type,ip,port,notes', 'A,toaster-9z,192.0.2.1,,', 'B,server,999.1.1.1-secret,,', 'C,server,192.0.2.3,0,', '=HYPERLINK(1),server,192.0.2.5,,', 'E,server,192.0.2.6,,+cmd', 'D,server,192.0.2.4,80,'].join('\n')
    const { rows, errors } = parseDevicesCsv(csv)
    expect(rows.map((r) => r.name)).toEqual(['D'])
    expect(errors.map((e) => [e.line, e.column])).toEqual([[2, 'type'], [3, 'ip'], [4, 'port'], [5, 'name'], [6, 'notes']])
    const text = JSON.stringify(errors)
    for (const v of ['toaster-9z', '999.1.1.1-secret', 'HYPERLINK', '+cmd']) expect(text).not.toContain(v)
  })

  it('final clean-up (Y-R8): an unknown column is named by its position, never by its text; a leading tab or carriage return is a formula too', () => {
    const r = parseDevicesCsv('name,type,ip,secret-column-text\nA,server,192.0.2.1,x\n')
    expect(r.warnings).toEqual([{ line: 1, column: 'column 4', message: 'This column is not used.' }])
    expect(JSON.stringify(r.warnings)).not.toContain('secret-column-text')
    const tabbed = parseDevicesCsv('name,type,ip,notes,location_code\n"\tcmd",server,192.0.2.1,,\nC,server,192.0.2.3,"\t=1+1",\nE,server,192.0.2.5,,"\tJCL"\nD,server,192.0.2.4,fine,\n')
    expect(tabbed.rows.map((x) => x.name)).toEqual(['D'])
    expect(tabbed.errors.map((e) => [e.line, e.column])).toEqual([[2, 'name'], [3, 'notes'], [4, 'location_code']])
    expect(tabbed.errors[0].message).toMatch(/tab/)
    // A carriage return inside a quoted value is refused as a line break inside a value.
    const cr = parseDevicesCsv('name,type,ip,notes\nB,server,192.0.2.2,"\rcalc"\n')
    expect(cr.rows).toEqual([])
    expect(cr.errors).toHaveLength(1)
  })

  it('the same address and port twice in one file is refused (the second line names the first)', () => {
    const r = parseDevicesCsv('name,type,ip,port\nA,server,192.0.2.1,22\nB,server,192.0.2.1,22\nC,server,192.0.2.1,23\n')
    expect(r.rows.map((x) => x.name)).toEqual(['A', 'C'])
    expect(r.errors).toEqual([{ line: 3, column: 'ip', message: 'Line 2 already gives a device at the same address and port.' }])
  })

  it('the sample file uses the new column name and reads without a problem', async () => {
    const { readFileSync } = await import('node:fs')
    const text = readFileSync('public/samples/devices-sample.csv', 'utf8')
    expect(text.split('\n')[0]).toBe('name,type,location_code,ip,port,notes')
    expect(parseDevicesCsv(text).errors).toEqual([])
  })

  it('refuses a file without the required columns, an empty file and a file that is not UTF-8', () => {
    expect(parseDevicesCsv('name,ip\nA,192.0.2.1\n').errors[0].message).toContain('name, type and ip')
    expect(parseDevicesCsv('').errors[0].message).toMatch(/empty/)
    expect(parseDevicesCsv('name,type,ip\nA�,server,192.0.2.1\n').fatal).toBe(true)
  })
})
