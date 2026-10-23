export type CsvRow = { line: number; cells: string[] }
/** A problem with one line of an imported file (release 1: moved here from the retired lib/import/stores-csv.ts). */
export type RowError = { line: number; message: string }

/**
 * Release 1 clean-ups (T-1 review L4): the ONE header rule of every CSV reader. `headers` are the row's column keys after the aliases
 * (location_code / store_code → code, …); where several columns have the same key, the FIRST one whose cell has a value is used, for
 * every column. `keep` limits the keys that are read.
 */
export function firstFilled(headers: string[], cells: string[], keep?: (key: string) => boolean): Record<string, string> {
  const v: Record<string, string> = {}
  headers.forEach((h, i) => {
    if (keep && !keep(h)) return
    if ((v[h] ?? '').trim() === '') v[h] = cells[i] ?? ''
  })
  return v
}

/** A row of the strict reader: `problem` says why it cannot be read (it must then not be used at all). `multiline`: a quoted value had a line break. */
export type StrictCsvRow = CsvRow & { problem?: 'stray_quote'; multiline?: number[]; lastLine?: number }

/**
 * The strict CSV reader of the validated import (P2-5c-2 review B-I1, RFC 4180): a quote opens a quoted value ONLY at the start of a
 * cell; a quote anywhere else in an unquoted value, or anything but a comma or the line end after a closing quote, marks that row as
 * unreadable (the row still ends at its line end, so the next rows are read whole and nothing shifts). A quote that is never closed
 * makes the rest of the file unreadable: `unclosedAt` is the line where it was opened and no row from there on is returned.
 * `multiline` lists the cell positions whose quoted value contains a line break; `lastLine` is then the line the row ends on (the
 * lines after `line` were swallowed by the quoted value: T-1, re-review N1). A leading byte-order mark is ignored; blank lines
 * are skipped but keep their line numbers.
 */
export function parseCsvStrict(input: string): { rows: StrictCsvRow[]; unclosedAt?: number } {
  const text = input.charCodeAt(0) === 0xfeff ? input.slice(1) : input
  const rows: StrictCsvRow[] = []
  let cells: string[] = []
  let field = ''
  let line = 1
  let startLine = 1
  let stray = false
  let multiline: number[] = []
  let quoted = false // the current cell started with a quote
  let inQuotes = false // inside the quotes of the current cell
  let quoteLine = 1
  const endCell = () => {
    cells.push(field)
    field = ''
    quoted = false
  }
  const endRow = () => {
    endCell()
    if (cells.some((c) => c.trim() !== '') || stray) rows.push({ line: startLine, cells, ...(stray ? { problem: 'stray_quote' as const } : {}), ...(multiline.length ? { multiline, ...(line > startLine ? { lastLine: line } : {}) } : {}) })
    cells = []
    stray = false
    multiline = []
  }
  for (let i = 0; i < text.length; i++) {
    const c = text[i]
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          field += '"'
          i++
        } else inQuotes = false
      } else {
        if (c === '\n' || c === '\r') {
          if (!multiline.includes(cells.length)) multiline.push(cells.length)
          if (c === '\r' && text[i + 1] === '\n') {
            field += '\r'
            i++
            field += '\n'
          } else field += c
          line++
          continue
        }
        field += c
      }
      continue
    }
    if (c === ',') endCell()
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++
      endRow()
      line++
      startLine = line
    } else if (c === '"') {
      if (field === '' && !quoted) {
        quoted = true
        inQuotes = true
        quoteLine = line
      } else stray = true
    } else {
      if (quoted) stray = true // text after the closing quote of a quoted value
      field += c
    }
  }
  if (inQuotes) return { rows: rows.filter((r) => r.line < startLine), unclosedAt: quoteLine }
  if (field !== '' || cells.length > 0 || quoted) endRow()
  return { rows }
}

/** Small CSV reader: quoted cells, doubled quotes, commas and line breaks inside quotes, Windows line endings, a leading BOM. */
export function parseCsv(input: string): CsvRow[] {
  const text = input.charCodeAt(0) === 0xfeff ? input.slice(1) : input
  const rows: CsvRow[] = []
  let cells: string[] = []
  let field = ''
  let inQuotes = false
  let line = 1
  let startLine = 1
  const endRow = () => {
    cells.push(field)
    if (cells.some((c) => c.trim() !== '')) rows.push({ line: startLine, cells })
    cells = []
    field = ''
  }
  for (let i = 0; i < text.length; i++) {
    const c = text[i]
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          field += '"'
          i++
        } else inQuotes = false
      } else {
        if (c === '\n') line++
        field += c
      }
    } else if (c === '"') inQuotes = true
    else if (c === ',') {
      cells.push(field)
      field = ''
    } else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++
      endRow()
      line++
      startLine = line
    } else field += c
  }
  if (field !== '' || cells.length > 0) endRow()
  return rows
}
