import { describe, expect, it } from 'vitest'
import { parseCsv } from '@/lib/import/csv'

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
