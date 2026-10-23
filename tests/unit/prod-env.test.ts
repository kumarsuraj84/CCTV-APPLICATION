import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { insideDir, PRODUCTION_FILES, productionEnvFiles } from '@/scripts/lib/prod-env.mjs'
import { peekClaims } from '@/scripts/lib/service-jwt.mjs'
import { startupProblems } from '@/lib/startup-checks'

// P5.4 brief item 3: `node scripts/gen-secrets.mjs --production --out-dir <folder>` writes the production env skeleton — one file per
// Windows service (web.env, worker.env, gateway.env, go2rtc.env) with only that service's lines — to a folder the operator chooses,
// never inside the repository, never over an existing file, and prints names only. Shared values (the video token secret of the web
// app and the gateway, go2rtc's login) are the same in every file; everything else is one value per purpose.

const SCRIPT = path.resolve(__dirname, '../../scripts/gen-secrets.mjs')
const REPO = path.resolve(__dirname, '../..')
const JWT = 'test-only-jwt-secret-that-is-long-enough-for-hs256'
let dir: string
beforeEach(() => {
  dir = mkdtempSync(path.join(os.tmpdir(), 'drishti-prod-env-'))
})
afterEach(() => rmSync(dir, { recursive: true, force: true }))

const parse = (text: string) => Object.fromEntries(text.split(/\r?\n/).filter((l) => /^[A-Z0-9_]+=/.test(l)).map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]))
const run = (...args: string[]) =>
  execFileSync(process.execPath, [SCRIPT, ...args], { encoding: 'utf8', env: { ...process.env, GEN_TEST_JWT: JWT }, stdio: ['ignore', 'pipe', 'pipe'] })

describe('production env skeleton (P5.4)', () => {
  it('one file per service, each with only its own lines; shared values equal, the others distinct', () => {
    const files = productionEnvFiles({ jwtSecret: JWT })
    expect(Object.keys(files).sort()).toEqual(['gateway.env', 'go2rtc.env', 'web.env', 'worker.env'])
    const web = parse(files['web.env'])
    const worker = parse(files['worker.env'])
    const gateway = parse(files['gateway.env'])
    const go2rtc = parse(files['go2rtc.env'])
    for (const f of [web, worker, gateway]) expect(f.DRISHTI_ENV).toBe('production')
    // Only the web app holds the full service key line (left for the operator: it comes from the project, not from here).
    expect('SUPABASE_SERVICE_ROLE_KEY' in web).toBe(true)
    expect(web.SUPABASE_SERVICE_ROLE_KEY).toBe('')
    for (const f of [worker, gateway, go2rtc]) expect('SUPABASE_SERVICE_ROLE_KEY' in f).toBe(false)
    // Each process its own database key, for its own role.
    expect(peekClaims(web.SUPABASE_APP_WEB_KEY)?.role).toBe('app_web')
    expect(peekClaims(web.SUPABASE_MEDIA_SERVICE_KEY)?.role).toBe('media_service')
    expect(peekClaims(worker.SUPABASE_MONITOR_WORKER_KEY)?.role).toBe('monitor_worker')
    expect(peekClaims(gateway.SUPABASE_VIDEO_GATEWAY_KEY)?.role).toBe('video_gateway')
    expect('SUPABASE_MONITOR_WORKER_KEY' in web || 'SUPABASE_APP_WEB_KEY' in gateway || 'SUPABASE_VIDEO_GATEWAY_KEY' in worker).toBe(false)
    // Shared values are the same; go2rtc gets its login and nothing else.
    expect(gateway.STREAM_TOKEN_SECRET).toBe(web.STREAM_TOKEN_SECRET)
    expect(gateway.GO2RTC_API_PASSWORD).toBe(web.GO2RTC_API_PASSWORD)
    expect(go2rtc).toEqual({ GO2RTC_API_USERNAME: 'drishti', GO2RTC_API_PASSWORD: web.GO2RTC_API_PASSWORD })
    // Loopback binding of the services behind the one https address (runbook-tls.md).
    expect(web.HOSTNAME).toBe('127.0.0.1')
    expect(web.PORT).toBe('3212')
    expect(gateway.GATEWAY_HOST).toBe('127.0.0.1')
    const secrets = Object.entries(web).filter(([k]) => /SECRET$|PASSWORD$/.test(k)).map(([, v]) => v)
    expect(new Set(secrets).size).toBe(secrets.length)
  })

  it('what it writes passes the production start-up check once the operator has filled the addresses', () => {
    const files = productionEnvFiles({ jwtSecret: JWT })
    const fill = { NEXT_PUBLIC_SUPABASE_URL: 'http://127.0.0.1:54321', SUPABASE_URL: 'http://127.0.0.1:54321', SUPABASE_SERVICE_ROLE_KEY: 'x', NEXT_PUBLIC_APP_URL: 'https://drishti.example.test', GATEWAY_ALLOWED_ORIGINS: 'https://drishti.example.test' }
    expect(startupProblems('web', { ...parse(files['web.env']), ...fill }).problems).toEqual([])
    expect(startupProblems('worker', { ...parse(files['worker.env']), ...fill, SUPABASE_SERVICE_ROLE_KEY: '' }).problems).toEqual([])
    expect(startupProblems('gateway', { ...parse(files['gateway.env']), ...fill, SUPABASE_SERVICE_ROLE_KEY: '' }).problems).toEqual([])
  })

  it('without the project JWT secret the database key lines stay empty (and say so)', () => {
    const web = parse(productionEnvFiles({})['web.env'])
    expect(web.SUPABASE_APP_WEB_KEY).toBe('')
    expect(web.STREAM_TOKEN_SECRET.length).toBeGreaterThanOrEqual(43)
  })

  it('PRODUCTION_FILES names exactly the four services', () => {
    expect(Object.keys(PRODUCTION_FILES).sort()).toEqual(['gateway.env', 'go2rtc.env', 'web.env', 'worker.env'])
  })

  it('insideDir: the repository and anything under it is inside; a sibling or another drive is not', () => {
    expect(insideDir(REPO, REPO)).toBe(true)
    expect(insideDir(path.join(REPO, 'deploy', 'x'), REPO)).toBe(true)
    expect(insideDir(path.join(REPO, '..', 'elsewhere'), REPO)).toBe(false)
    expect(insideDir(dir, REPO)).toBe(false)
  })

  it('the script writes the four files to the chosen folder, prints names only, and never overwrites', () => {
    const out = run('--production', '--out-dir', dir, '--jwt-secret-env', 'GEN_TEST_JWT')
    for (const f of ['web.env', 'worker.env', 'gateway.env', 'go2rtc.env']) expect(existsSync(path.join(dir, f)), f).toBe(true)
    const web = parse(readFileSync(path.join(dir, 'web.env'), 'utf8'))
    for (const [k, v] of Object.entries(web)) if (v.length >= 16) expect(out, k).not.toContain(v)
    expect(out).toContain('web.env')
    expect(out).toMatch(/-Action Install/)
    // Never over an existing file.
    writeFileSync(path.join(dir, 'worker.env'), 'MINE=1\n')
    expect(() => run('--production', '--out-dir', dir, '--jwt-secret-env', 'GEN_TEST_JWT')).toThrow()
    expect(readFileSync(path.join(dir, 'worker.env'), 'utf8')).toBe('MINE=1\n')
  })

  // Review I-7: on Windows the files never carry the folder's inherited ACL (Authenticated Users / Users), and a rotation keeps the
  // ACL the install gave a file (the service account's read right), instead of the temporary file's.
  it.skipIf(process.platform !== 'win32')('Windows: new env files are locked (no inherited entry, no Users), and a rotation keeps the file ACL', () => {
    const icacls = (p: string) => execFileSync('icacls', [p], { encoding: 'utf8' })
    const out = path.join(dir, 'config')
    run('--production', '--out-dir', out, '--jwt-secret-env', 'GEN_TEST_JWT')
    for (const f of ['web.env', 'worker.env', 'gateway.env', 'go2rtc.env', '']) {
      const acl = icacls(path.join(out, f))
      expect(acl, f).not.toMatch(/\(I\)/)
      expect(acl, f).not.toMatch(/Authenticated Users|\\Users:|Everyone/i)
      expect(acl, f).toMatch(/SYSTEM/)
      expect(acl, f).toMatch(/Administrators/)
    }
    const web = path.join(out, 'web.env')
    execFileSync('icacls', [web, '/grant', '*S-1-5-19:R'], { stdio: 'ignore' }) // stands in for NT SERVICE\DrishtiWeb (LOCAL SERVICE)
    const before = parse(readFileSync(web, 'utf8')).CRON_SECRET
    run('--file', web, '--only=CRON_SECRET', '--rotate=CRON_SECRET')
    expect(parse(readFileSync(web, 'utf8')).CRON_SECRET).not.toBe(before)
    expect(icacls(web)).toMatch(/LOCAL SERVICE/)
    expect(icacls(web)).not.toMatch(/\(I\)/)
    expect(readdirSync(out).filter((f) => f.includes('.tmp-'))).toEqual([])
  })

  it('the script refuses a folder inside the repository, writing nothing', () => {
    const target = path.join(REPO, 'deploy', 'p54-should-not-exist')
    expect(() => run('--production', '--out-dir', target)).toThrow()
    expect(existsSync(target)).toBe(false)
    expect(() => run('--production')).toThrow() // --out-dir is required
  })
})
