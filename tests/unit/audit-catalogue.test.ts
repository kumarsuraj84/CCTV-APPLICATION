import { readdirSync, readFileSync, statSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { AUDIT_ACTIONS } from '@/lib/audit/catalogue'

// P5.4 brief item 5: the catalogue of audit actions (lib/audit/catalogue.ts) against the source, both ways: every catalogued action is
// named by the file said to write it, and every action the code or a migration writes is catalogued. The runtime half (the rows are
// really written) is tests/integration/audit-coverage.test.ts.

const ROOT = path.resolve(__dirname, '../..')
const read = (rel: string) => readFileSync(path.join(ROOT, rel), 'utf8')
function files(dir: string, ext: RegExp): string[] {
  const out: string[] = []
  for (const e of readdirSync(path.join(ROOT, dir))) {
    const rel = `${dir}/${e}`
    if (statSync(path.join(ROOT, rel)).isDirectory()) out.push(...files(rel, ext))
    else if (ext.test(e)) out.push(rel)
  }
  return out
}

// Not audit writers: the job engine's decisions and the import plan's row actions use a field called "action" too.
const NOT_AUDIT = new Set(['lib/jobs/engine.ts', 'lib/import/locations-plan.ts', 'lib/audit/catalogue.ts'])
const catalogued = new Set(AUDIT_ACTIONS.map((a) => `${a.table}:${a.action}`))

describe('audit catalogue (P5.4)', () => {
  it('has no duplicates, and the required categories are all there', () => {
    expect(catalogued.size).toBe(AUDIT_ACTIONS.length)
    const required = [
      'admin_audit_log:access_granted', 'admin_audit_log:access_revoked', // grants and revocations
      'auth_events:sign_in', 'auth_events:sign_in_failed', // sign-ins and failures
      'auth_events:mfa_enrolled', 'auth_events:mfa_verified', 'auth_events:mfa_failed', 'auth_events:mfa_removed', // two-step events
      'admin_audit_log:cctv_live_opened', 'admin_audit_log:cctv_playback_opened', // stream opens
      'admin_audit_log:recorder_password_set', // credential writes
      'admin_audit_log:locations_imported', // imports
      'admin_audit_log:inventory_archived', 'admin_audit_log:inventory_restored', // archive and restore
      'admin_audit_log:camera_merged', // merge
      'admin_audit_log:mfa_factor_reset', 'auth_events:mfa_factor_reset', // factor reset
    ]
    for (const r of required) expect(catalogued.has(r), r).toBe(true)
  })

  it("every catalogued action is named by the file that writes it", () => {
    for (const a of AUDIT_ACTIONS) {
      const text = read(a.writer)
      expect(text.includes(`'${a.action}'`) || text.includes(`"${a.action}"`), `${a.action} in ${a.writer}`).toBe(true)
    }
  })

  it('every auth_events kind the database accepts is catalogued, and nothing else is', () => {
    const sql = read('supabase/migrations/20261021000034_p31_mfa_sessions.sql')
    const check = /event text NOT NULL CHECK \(event IN \(([^)]*)\)\)/.exec(sql)
    expect(check).not.toBeNull()
    const kinds = [...check![1].matchAll(/'([a-z_]+)'/g)].map((m) => m[1]).sort()
    const ours = AUDIT_ACTIONS.filter((a) => a.table === 'auth_events').map((a) => a.action).sort()
    expect(ours).toEqual(kinds)
  })

  it('every action literal written to admin_audit_log in lib/, app/ or proxy.ts is catalogued', () => {
    const found = new Set<string>()
    for (const f of [...files('lib', /\.tsx?$/), ...files('app', /\.tsx?$/), 'proxy.ts']) {
      if (NOT_AUDIT.has(f)) continue
      const t = read(f)
      for (const m of t.matchAll(/action: (?:[a-zA-Z.]+ \? )?'([a-z_]+)'(?: : '([a-z_]+)')?/g)) {
        found.add(m[1])
        if (m[2]) found.add(m[2])
      }
    }
    // lib/groups/service.ts and lib/auth/access-audit.ts callers pass the action as a plain argument; both are covered by the writer check.
    expect(found.size).toBeGreaterThan(30)
    for (const a of found) expect(catalogued.has(`admin_audit_log:${a}`), a).toBe(true)
  })

  it('every action a migration writes to admin_audit_log is catalogued (literal or either branch of a CASE)', () => {
    const found = new Set<string>()
    for (const f of files('supabase/migrations', /\.sql$/)) {
      const t = read(f)
      for (const m of t.matchAll(/INSERT INTO public\.admin_audit_log \([^)]*\)\s*(VALUES \(|SELECT )([\s\S]{0,400})/g)) {
        // The third value is the action: skip the first two (organisation, actor) at the top level of the list.
        const rest = m[2]
        let depth = 0
        let commas = 0
        let i = 0
        for (; i < rest.length && commas < 2; i++) {
          const ch = rest[i]
          if (ch === '(') depth++
          else if (ch === ')') depth--
          else if (ch === ',' && depth === 0) commas++
        }
        const third = /^\s*(CASE[\s\S]*?END|'[a-z_]+')/.exec(rest.slice(i))
        expect(third, `${f}: ${rest.slice(i, i + 60)}`).not.toBeNull()
        for (const lit of third![1].matchAll(/'([a-z_]+)'/g)) found.add(lit[1])
      }
    }
    expect(found.size).toBeGreaterThan(10)
    for (const a of found) expect(catalogued.has(`admin_audit_log:${a}`), a).toBe(true)
  })
})
