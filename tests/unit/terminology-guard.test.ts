import { readdirSync, readFileSync, statSync } from 'node:fs'
import path from 'node:path'
import ts from 'typescript'
import { describe, expect, it } from 'vitest'
import { ALLOWED } from './terminology-allowlist'

// T-1 guard (ruling T-1): no string the application can show says "store". The scan reads the real syntax tree, so comments,
// imports, identifiers and property names (code) are never counted; only string literals, template text and JSX text are.
// The few intentional exceptions live in tests/unit/terminology-allowlist.ts, each with its reason.

const ROOT = path.resolve(__dirname, '..', '..')
// Release 1 clean-ups (T-1 review L1): services/ is scanned too, and the PowerShell agent's strings (agent/, below).
const DIRS = ['app', 'components', 'lib', 'scripts', 'services']
// L1: also the joined forms people read in help and messages: store_code, store-name, storeId (a word character next to "store" hid
// them from \bstores?\b).
const WORD = /\bstores?\b|\bstore[_-]?(?:code|name|id)s?\b|\bstore(?:Code|Name|Id)s?\b/i

function files(dir: string): string[] {
  const out: string[] = []
  for (const name of readdirSync(dir)) {
    const full = path.join(dir, name)
    if (statSync(full).isDirectory()) { if (name !== 'node_modules') out.push(...files(full)) }
    else if (/\.(ts|tsx|mjs)$/.test(name) && !name.endsWith('.d.ts')) out.push(full)
  }
  return out
}

/**
 * Release 1 (L1): a string that is code, not wording — a field or column name, a PostgREST select list, a header value: every
 * comma-separated part is one lower-case token with no space, and each part that says "store" carries a code character (_ : ( ! -).
 * A plain word ("Stores", "store") or any sentence is wording. This replaces the old `partial` allow-list entries, which let any string
 * of the file through.
 */
function codeLike(text: string): boolean {
  const parts = text.split(',').map((p) => p.trim())
  return parts.every((p) => /^[a-z0-9_!:.()*-]+$/.test(p)) && parts.filter((p) => WORD.test(p)).every((p) => /[_:(!-]/.test(p))
}

export function wordingOf(source: string, fileName: string): { line: number; text: string }[] {
  const sf = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true, fileName.endsWith('x') ? ts.ScriptKind.TSX : ts.ScriptKind.TS)
  const found: { line: number; text: string }[] = []
  const add = (node: ts.Node, text: string) => { if (WORD.test(text) && !codeLike(text.trim())) found.push({ line: sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1, text: text.trim().slice(0, 120) }) }
  const visit = (node: ts.Node) => {
    if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) return
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) add(node, node.text)
    else if (ts.isTemplateHead(node) || ts.isTemplateMiddle(node) || ts.isTemplateTail(node)) add(node, node.text)
    else if (ts.isJsxText(node)) add(node, node.text)
    ts.forEachChild(node, visit)
  }
  visit(sf)
  return found
}

describe('the wording is "location", not "store" (ruling T-1)', () => {
  it('the scanner sees strings and JSX text but not code or comments', () => {
    const src = [
      "import { listVisibleStores } from '@/lib/store'",
      '// the store is a comment',
      'const storeId = 1',
      "const a = 'Manage stores'",
      'const b = `Add a store for ${storeId}`',
      'const c = <p>Open the store</p>',
      "const d = 'Cache-Control: no-store'",
      "const e = 'restore'",
    ].join('\n')
    expect(wordingOf(src, 'x.tsx').map((f) => f.text)).toEqual(['Manage stores', 'Add a store for', 'Open the store', 'Cache-Control: no-store'])
  })

  it('release 1 (L1): the joined forms are seen too, and "restore" or "storage" are not', () => {
    const src = ["const a = 'Use the store_code column'", "const b = 'Pick a store-name'", "const c = `Your storeId ${1}`", "const d = 'restore the storage'"].join('\n')
    expect(wordingOf(src, 'x.ts').map((f) => f.text)).toEqual(['Use the store_code column', 'Pick a store-name', 'Your storeId'])
  })

  it('release 1 (L1): code strings (a field name, a PostgREST select list, a header value) are not wording; a sentence in the same file is', () => {
    const src = ["const a = 'store_id'", "const b = 'id, store_id:location_id, name'", "const c = 'no-store, private'", "const d = 'id, stores:locations(id, name)'",
      "const e = 'Could not read the stores.'", "const f = 'Stores'", "const g = 'store'"].join('\n')
    expect(wordingOf(src, 'x.ts').map((f) => f.text)).toEqual(['Could not read the stores.', 'Stores', 'store'])
  })

  it('release 1 (L1): no string of the PowerShell agent says store', () => {
    const offenders: string[] = []
    const ps = (dir: string): string[] => readdirSync(dir).flatMap((n) => {
      const full = path.join(dir, n)
      return statSync(full).isDirectory() ? ps(full) : /\.(ps1|psm1)$/.test(n) ? [full] : []
    })
    for (const f of ps(path.join(ROOT, 'agent'))) {
      readFileSync(f, 'utf8').split(/\r?\n/).forEach((line, i) => {
        if (/^\s*#/.test(line)) return
        for (const m of line.matchAll(/"([^"]*)"|'([^']*)'/g)) if (WORD.test(m[1] ?? m[2] ?? '')) offenders.push(`${path.relative(ROOT, f)}:${i + 1}  ${(m[1] ?? m[2]).slice(0, 80)}`)
      })
    }
    expect(offenders).toEqual([])
  })

  it('no string in app/, components/, lib/ or scripts/ says store, outside the documented allow-list', () => {
    const offenders: string[] = []
    const used = new Set<number>()
    for (const dir of DIRS) {
      for (const full of files(path.join(ROOT, dir))) {
        const rel = path.relative(ROOT, full).split(path.sep).join('/')
        for (const f of wordingOf(readFileSync(full, 'utf8'), rel)) {
          const idx = ALLOWED.findIndex((a) => a.file === rel && (a.partial ? f.text.includes(a.text) : f.text === a.text))
          if (idx >= 0) used.add(idx)
          else offenders.push(`${rel}:${f.line}  ${f.text}`)
        }
      }
    }
    expect(offenders).toEqual([])
    // An entry that no longer matches anything is dead weight: remove it, so the list stays an honest record of the exceptions.
    const dead = ALLOWED.filter((_, i) => !used.has(i)).map((a) => `${a.file} (${a.text})`)
    expect(dead).toEqual([])
  })

  it('every allow-list entry gives a reason', () => {
    expect(ALLOWED.filter((a) => a.reason.trim().length < 10)).toEqual([])
  })
})
