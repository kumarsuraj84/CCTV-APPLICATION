import { readdirSync, readFileSync, statSync } from 'node:fs'
import path from 'node:path'
import ts from 'typescript'
import { describe, expect, it } from 'vitest'
import { ALLOWED } from './terminology-allowlist'

// T-1 guard (ruling T-1): no string the application can show says "store". The scan reads the real syntax tree, so comments,
// imports, identifiers and property names (code) are never counted; only string literals, template text and JSX text are.
// The few intentional exceptions live in tests/unit/terminology-allowlist.ts, each with its reason.

const ROOT = path.resolve(__dirname, '..', '..')
const DIRS = ['app', 'components', 'lib', 'scripts']
const WORD = /\bstores?\b/i

function files(dir: string): string[] {
  const out: string[] = []
  for (const name of readdirSync(dir)) {
    const full = path.join(dir, name)
    if (statSync(full).isDirectory()) { if (name !== 'node_modules') out.push(...files(full)) }
    else if (/\.(ts|tsx|mjs)$/.test(name) && !name.endsWith('.d.ts')) out.push(full)
  }
  return out
}

export function wordingOf(source: string, fileName: string): { line: number; text: string }[] {
  const sf = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true, fileName.endsWith('x') ? ts.ScriptKind.TSX : ts.ScriptKind.TS)
  const found: { line: number; text: string }[] = []
  const add = (node: ts.Node, text: string) => { if (WORD.test(text)) found.push({ line: sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1, text: text.trim().slice(0, 120) }) }
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
