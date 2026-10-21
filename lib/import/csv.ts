export type CsvRow = { line: number; cells: string[] }

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
