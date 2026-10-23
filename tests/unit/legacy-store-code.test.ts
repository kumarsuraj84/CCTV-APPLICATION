import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

// Release 1 clean-ups (T-1 review L2): the legacy location paths (importStores with its arbitrary "primary NVR" pick, parseStoresCsv,
// createStore / updateStore / deleteStore, storeSchema) left lib/; they live on only as a test fixture (tests/setup/legacy-import.ts).
// The application must never reach them again. The per-location discovery is kept, tested and named for locations.

const ROOT = path.resolve(__dirname, '../..')
function walk(dir: string, out: string[] = []): string[] {
  for (const e of readdirSync(dir)) {
    const p = path.join(dir, e)
    if (e === 'node_modules' || e.startsWith('.')) continue
    if (statSync(p).isDirectory()) walk(p, out)
    else if (/\.(ts|tsx|mjs)$/.test(e)) out.push(p)
  }
  return out
}
const appFiles = () => ['app', 'components', 'lib', 'services', 'scripts'].flatMap((d) => walk(path.join(ROOT, d)))

describe('the legacy location code is a test fixture only', () => {
  it('the old modules are gone from lib/', () => {
    for (const f of ['lib/import/stores-csv.ts', 'lib/inventory/stores.ts']) expect(existsSync(path.join(ROOT, f)), f).toBe(false)
  })

  it('nothing in app/, components/, lib/, services/ or scripts/ imports the fixture or defines the old functions', () => {
    const offenders = appFiles().filter((f) => {
      const t = readFileSync(f, 'utf8')
      // An import of the fixture (the audit catalogue may NAME it as the writer of old rows; that is a string, not an import).
      return /(?:from|import\()\s*['"][^'"]*legacy-import['"]/.test(t) ||
        /\b(?:function|const)\s+(?:importStores|parseStoresCsv|createStore|updateStore|deleteStore|discoverStoreCameras|storeSchema)\b/.test(t)
    }).map((f) => path.relative(ROOT, f))
    expect(offenders).toEqual([])
  })

  it('the per-location discovery stays, named for locations', () => {
    const src = readFileSync(path.join(ROOT, 'lib/monitor/discovery.ts'), 'utf8')
    expect(src).toMatch(/export async function discoverLocationCameras\(/)
  })
})
