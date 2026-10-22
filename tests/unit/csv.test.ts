import { describe, expect, it } from 'vitest'
import { parseCsv, parseCsvStrict } from '@/lib/import/csv'

describe('parseCsv', () => {
  it('reads plain rows and numbers them by line', () => {
    expect(parseCsv('a,b\n1,2\n')).toEqual([{ line: 1, cells: ['a', 'b'] }, { line: 2, cells: ['1', '2'] }])
  })
  it('handles quotes, commas inside quotes, doubled quotes and Windows line endings', () => {
    const rows = parseCsv('name,note\r\n"Store, North","say ""hi"""\r\n')
    expect(rows[1].cells).toEqual(['Store, North', 'say "hi"'])
  })
  it('ignores a leading byte-order mark and skips blank lines but keeps line numbers', () => {
    const rows = parseCsv('\ufeffa,b\n\n3,4')
    expect(rows).toEqual([{ line: 1, cells: ['a', 'b'] }, { line: 3, cells: ['3', '4'] }])
  })
  it('keeps empty cells', () => {
    expect(parseCsv('a,,c')[0].cells).toEqual(['a', '', 'c'])
  })
})

// T-1 carry-over (P2-5c re-review N1): a quoted value that runs over several lines swallows them; the reader says which lines.
describe('parseCsvStrict: the lines a quoted value runs over', () => {
  it('a row that stays on one line has no last line of its own', () => {
    const { rows } = parseCsvStrict('a,b\n1,2\n')
    expect(rows.map((r) => [r.line, r.lastLine])).toEqual([[1, undefined], [2, undefined]])
  })

  it('a quote opened on line 2 and closed on line 4 makes one row from line 2 to line 4; the next row keeps its own line number', () => {
    const { rows } = parseCsvStrict('a,b\n1,"x\ny\nz",3\n4,5\n')
    expect(rows.map((r) => [r.line, r.lastLine])).toEqual([[1, undefined], [2, 4], [5, undefined]])
  })

  it('counts a Windows line break and a bare carriage return as one line each', () => {
    expect(parseCsvStrict('a,b\r\n1,"x\r\ny",3\r\n4,5\r\n').rows.map((r) => [r.line, r.lastLine])).toEqual([[1, undefined], [2, 3], [4, undefined]])
    expect(parseCsvStrict('a,b\r1,"x\ry",3\r4,5\r').rows.map((r) => [r.line, r.lastLine])).toEqual([[1, undefined], [2, 3], [4, undefined]])
  })
})
