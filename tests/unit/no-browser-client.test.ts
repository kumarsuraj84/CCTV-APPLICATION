import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

// Release 1 clean-ups (P3-1 re-review N-2): the auth cookies are HttpOnly (P3-1 I-1), so a browser Supabase client could not read the
// session and would quietly fail. The unused lib/supabase/client.ts is gone, and nothing may make a browser client again.

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

describe('no browser Supabase client (HttpOnly auth cookies)', () => {
  it('lib/supabase/client.ts is gone', () => {
    expect(existsSync(path.join(ROOT, 'lib/supabase/client.ts'))).toBe(false)
  })

  it('no code in app/, components/, lib/ or services/ makes a browser client or imports the old module', () => {
    const offenders = ['app', 'components', 'lib', 'services'].flatMap((d) => walk(path.join(ROOT, d)))
      .filter((f) => /createBrowserClient|['"]@\/lib\/supabase\/client['"]/.test(readFileSync(f, 'utf8')))
      .map((f) => path.relative(ROOT, f))
    expect(offenders).toEqual([])
  })
})
