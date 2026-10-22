import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { go2rtcEnvProblems } from '@/scripts/lib/go2rtc-env.mjs'

// P2-6 review round 1, I-2: `npm run stack:up` runs scripts/check-go2rtc-env.mjs first. In production mode (DRISHTI_ENV=production or
// NODE_ENV=production, the same switch as the app: scripts/lib/runtime-mode.mjs) it refuses to start go2rtc without its API login
// (both values, the password 32+ characters), because go2rtc with empty values runs with no login at all. Development: a warning only.
// The values are never printed.

const ROOT = path.resolve(__dirname, '../..')
const SCRIPT = path.join(ROOT, 'scripts', 'check-go2rtc-env.mjs')
const dir = mkdtempSync(path.join(os.tmpdir(), 'drishti-go2rtc-env-'))
afterAll(() => rmSync(dir, { recursive: true, force: true }))
const PASSWORD = 'Pw-0123456789-abcdefghij-0123456789-XYZ'

/** A minimal child environment (no NODE_ENV on purpose: production must come from DRISHTI_ENV or the file). */
const childEnv = (env: Record<string, string>) => ({ PATH: process.env.PATH ?? '', SystemRoot: process.env.SystemRoot ?? '', ...env }) as unknown as NodeJS.ProcessEnv

function run(fileLines: string[], env: Record<string, string> = {}) {
  const file = path.join(dir, `env-${Math.random().toString(36).slice(2)}`)
  writeFileSync(file, fileLines.join('\r\n'))
  const r = spawnSync(process.execPath, [SCRIPT, '--compose-env', file], { encoding: 'utf8', env: childEnv(env), windowsHide: true })
  return { code: r.status, out: `${r.stdout}${r.stderr}` }
}

describe('go2rtc login check before the stack starts (review I-2)', () => {
  it('the rule: production needs both values and a password of 32+ characters; development only warns', () => {
    expect(go2rtcEnvProblems({ DRISHTI_ENV: 'production' }).problems.join(' ')).toMatch(/GO2RTC_API_USERNAME.*GO2RTC_API_PASSWORD|GO2RTC_API_PASSWORD.*GO2RTC_API_USERNAME/)
    expect(go2rtcEnvProblems({ DRISHTI_ENV: 'production', GO2RTC_API_USERNAME: 'drishti', GO2RTC_API_PASSWORD: 'x'.repeat(31) }).problems.join(' ')).toContain('32')
    expect(go2rtcEnvProblems({ DRISHTI_ENV: 'production', GO2RTC_API_USERNAME: 'drishti', GO2RTC_API_PASSWORD: PASSWORD }).problems).toEqual([])
    expect(go2rtcEnvProblems({ NODE_ENV: 'production' }).problems.length).toBeGreaterThan(0)
    const dev = go2rtcEnvProblems({})
    expect(dev.problems).toEqual([])
    expect(dev.warnings.join(' ')).toContain('without a login')
  })

  it('production from the env file without the login: refused (exit 1), with a plain line', () => {
    const r = run(['DRISHTI_ENV=production', 'GO2RTC_API_USERNAME=', 'GO2RTC_API_PASSWORD='])
    expect(r.code).toBe(1)
    expect(r.out).toContain('GO2RTC_API_PASSWORD')
    expect(r.out).toContain('gen-secrets')
  })

  it('production with a short password: refused, and the value is never printed', () => {
    const r = run(['DRISHTI_ENV=production', 'GO2RTC_API_USERNAME=drishti', `GO2RTC_API_PASSWORD=${PASSWORD.slice(0, 20)}`])
    expect(r.code).toBe(1)
    expect(r.out).not.toContain(PASSWORD.slice(0, 20))
    expect(r.out).not.toContain('drishti=')
  })

  it('production with both values: go ahead (exit 0), nothing printed about the values', () => {
    const r = run(['DRISHTI_ENV=production', 'GO2RTC_API_USERNAME=drishti', `GO2RTC_API_PASSWORD=${PASSWORD}`])
    expect(r.code).toBe(0)
    expect(r.out).not.toContain(PASSWORD)
  })

  it('the shell environment wins over the file, as with docker compose', () => {
    const r = run(['GO2RTC_API_USERNAME=drishti', `GO2RTC_API_PASSWORD=${PASSWORD}`], { DRISHTI_ENV: 'production', GO2RTC_API_PASSWORD: '' })
    expect(r.code).toBe(1)
  })

  it('development without the login: a warning, and the stack starts', () => {
    const r = run(['GO2RTC_API_USERNAME=', 'GO2RTC_API_PASSWORD='])
    expect(r.code).toBe(0)
    expect(r.out).toContain('without a login')
  })

  it('no env file: production refuses, development goes ahead', () => {
    const missing = path.join(dir, 'does-not-exist')
    const prod = spawnSync(process.execPath, [SCRIPT, '--compose-env', missing], { encoding: 'utf8', env: childEnv({ DRISHTI_ENV: 'production' }) })
    expect(prod.status).toBe(1)
    const dev = spawnSync(process.execPath, [SCRIPT, '--compose-env', missing], { encoding: 'utf8', env: childEnv({}) })
    expect(dev.status).toBe(0)
  })
})
