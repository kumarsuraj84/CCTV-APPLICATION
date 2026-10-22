import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { ALL_KEYS, plan, presentKeys, render, SERVICE_KEYS } from '@/scripts/lib/gen-secrets-core.mjs'
import { peekClaims } from '@/scripts/lib/service-jwt.mjs'

// P2-6 (brief item 2): scripts/gen-secrets.mjs writes strong secrets and the per-service database keys to a file only, never prints a
// value, and never overwrites a value that is set unless --rotate says so. Run against temporary files only (never the real .env.local).

const SCRIPT = path.resolve(__dirname, '../../scripts/gen-secrets.mjs')
const JWT = 'test-only-jwt-secret-that-is-long-enough-for-hs256'
let dir: string
beforeEach(() => {
  dir = mkdtempSync(path.join(os.tmpdir(), 'drishti-gen-secrets-'))
})
afterEach(() => rmSync(dir, { recursive: true, force: true }))

const run = (file: string, ...extra: string[]) =>
  execFileSync(process.execPath, [SCRIPT, '--file', file, '--jwt-secret-env', 'GEN_TEST_JWT', ...extra], { encoding: 'utf8', env: { ...process.env, GEN_TEST_JWT: JWT } })
const values = (file: string) => Object.fromEntries(readFileSync(file, 'utf8').split('\n').filter((l) => /^[A-Z0-9_]+=/.test(l)).map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]))

describe('scripts/gen-secrets.mjs', () => {
  it('adds every missing key to the file, prints only names, and makes strong, different values', () => {
    const file = path.join(dir, '.env.test')
    writeFileSync(file, '# mine\nNEXT_PUBLIC_SUPABASE_URL=http://127.0.0.1:55321\nCRON_SECRET=\n')
    const out = run(file)
    const v = values(file)
    for (const k of ALL_KEYS) expect(v[k], k).toBeTruthy()
    for (const k of ALL_KEYS) expect(out).not.toContain(v[k] === 'drishti' ? 'GO2RTC_API_USERNAME=drishti' : v[k])
    expect(out).toContain('Added:')
    const randoms = Object.entries(v).filter(([k]) => /SECRET$|PASSWORD$/.test(k)).map(([, val]) => val)
    expect(new Set(randoms).size).toBe(randoms.length)
    for (const r of randoms) expect(r.length).toBeGreaterThanOrEqual(43)
    // The file's own lines are kept.
    expect(readFileSync(file, 'utf8').startsWith('# mine\nNEXT_PUBLIC_SUPABASE_URL=http://127.0.0.1:55321\n')).toBe(true)
  })

  it('signs one key per service role, naming that role', () => {
    const file = path.join(dir, '.env.test')
    run(file)
    const v = values(file)
    expect(peekClaims(v.SUPABASE_APP_WEB_KEY)).toMatchObject({ role: 'app_web' })
    expect(peekClaims(v.SUPABASE_MEDIA_SERVICE_KEY)).toMatchObject({ role: 'media_service' })
    expect(peekClaims(v.SUPABASE_MONITOR_WORKER_KEY)).toMatchObject({ role: 'monitor_worker' })
    expect(peekClaims(v.SUPABASE_VIDEO_GATEWAY_KEY)).toMatchObject({ role: 'video_gateway' })
    for (const k of SERVICE_KEYS) expect((peekClaims(v[k]) as { exp: number }).exp).toBeGreaterThan(Date.now() / 1000 + 300 * 24 * 3600)
  })

  it('never overwrites a set value without --rotate; --rotate=NAME replaces only that one; --rotate replaces every generated one', () => {
    const file = path.join(dir, '.env.test')
    run(file)
    const first = values(file)
    expect(run(file)).toContain('nothing written')
    expect(values(file)).toEqual(first)
    run(file, '--rotate=STREAM_TOKEN_SECRET')
    const second = values(file)
    expect(second.STREAM_TOKEN_SECRET).not.toBe(first.STREAM_TOKEN_SECRET)
    for (const k of ALL_KEYS.filter((k) => k !== 'STREAM_TOKEN_SECRET')) expect(second[k], k).toBe(first[k])
    const out = run(file, '--rotate')
    const third = values(file)
    for (const k of ALL_KEYS.filter((k) => k !== 'GO2RTC_API_USERNAME')) expect(third[k], k).not.toBe(second[k])
    expect(third.GO2RTC_API_USERNAME).toBe('drishti') // a plain setting is not rotated
    for (const k of ALL_KEYS) if (k !== 'GO2RTC_API_USERNAME') expect(out).not.toContain(third[k])
  })

  it('a dry run writes nothing; an unknown key is refused', () => {
    const file = path.join(dir, '.env.test')
    writeFileSync(file, 'X=1\n')
    expect(run(file, '--dry-run')).toContain('nothing written')
    expect(readFileSync(file, 'utf8')).toBe('X=1\n')
    expect(() => run(file, '--rotate=NOT_A_KEY')).toThrow()
  })
})

describe('gen-secrets core', () => {
  it('reads which keys are set (an empty value is not set)', () => {
    expect([...presentKeys('A=1\nB=\n# C=3\n D = 4\nE=""\n')]).toEqual(['A', 'D'])
  })
  it('plans add / keep / rotate and renders in place without touching other lines', () => {
    const text = 'CRON_SECRET=old\n# note\nOTHER=1\n'
    const steps = plan(text, { rotate: new Set(['CRON_SECRET']), only: ['CRON_SECRET', 'WORKER_SECRET'] })
    expect(steps).toEqual([{ key: 'CRON_SECRET', action: 'rotate' }, { key: 'WORKER_SECRET', action: 'add' }])
    const out = render(text, steps, { CRON_SECRET: 'new1', WORKER_SECRET: 'new2' })
    expect(out.split('\n').slice(0, 3)).toEqual(['CRON_SECRET=new1', '# note', 'OTHER=1'])
    expect(out).toContain('WORKER_SECRET=new2')
  })
  it('review M-14: an empty KEY= line is filled in place (no second line for the same key)', () => {
    const text = 'CRON_SECRET=\n# note\nWORKER_SECRET=""\n'
    const steps = plan(text, { only: ['CRON_SECRET', 'WORKER_SECRET'] })
    expect(steps).toEqual([{ key: 'CRON_SECRET', action: 'add' }, { key: 'WORKER_SECRET', action: 'add' }])
    const out = render(text, steps, { CRON_SECRET: 'new1', WORKER_SECRET: 'new2' })
    expect(out).toBe('CRON_SECRET=new1\n# note\nWORKER_SECRET=new2\n')
  })
  it('review M-14: a file with Windows line ends keeps them', () => {
    const text = 'CRON_SECRET=old\r\n# note\r\nOTHER=1\r\n'
    const out = render(text, plan(text, { rotate: new Set(['CRON_SECRET']), only: ['CRON_SECRET', 'WORKER_SECRET'] }), { CRON_SECRET: 'new1', WORKER_SECRET: 'new2' })
    expect(out.startsWith('CRON_SECRET=new1\r\n# note\r\nOTHER=1\r\n')).toBe(true)
    expect(out.replace(/\r\n/g, '')).not.toContain('\n')
    expect(out.endsWith('WORKER_SECRET=new2\r\n')).toBe(true)
  })
})
