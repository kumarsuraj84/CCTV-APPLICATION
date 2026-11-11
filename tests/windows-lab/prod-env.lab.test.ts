// P5.4 Windows lab suite: the env files gen-secrets.mjs writes carry real locked access lists (review I-7, re-review M-new-5,
// review 2 N-3). Moved out of tests/unit/prod-env.test.ts in fix round 3 (the owner's antivirus); the default test records the locks
// instead (DRISHTI_ACL_RECORD). gen-secrets refuses any folder inside the repository, so this file works in a folder under the system
// temporary folder (drishti-lab-prod-env-*), removed afterwards.
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { assertLab, grant, icacls, ICACLS, ROOT } from './lab'

assertLab()

const SCRIPT = path.join(ROOT, 'scripts', 'gen-secrets.mjs')
const JWT = 'test-only-jwt-secret-that-is-long-enough-for-hs256'
let dir = ''
beforeEach(() => {
  dir = mkdtempSync(path.join(os.tmpdir(), 'drishti-lab-prod-env-'))
})
afterEach(async () => {
  const { rmSync } = await import('node:fs')
  const me = /"(S-1-[0-9-]+)"/.exec(execFileSync(path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'whoami.exe'), ['/user', '/fo', 'csv', '/nh'], { encoding: 'utf8' }))?.[1]
  if (me) execFileSync(ICACLS, [dir, '/grant', `*${me}:(OI)(CI)F`, '/T', '/C', '/Q'], { stdio: 'ignore' })
  rmSync(dir, { recursive: true, force: true })
})

const parse = (text: string) => Object.fromEntries(text.split(/\r?\n/).filter((l) => /^[A-Z0-9_]+=/.test(l)).map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]))
// Without DRISHTI_ACL_RECORD: the real locks.
const run = (...args: string[]) => {
  const env: NodeJS.ProcessEnv = { ...process.env, GEN_TEST_JWT: JWT }
  delete env.DRISHTI_ACL_RECORD
  return execFileSync(process.execPath, [SCRIPT, ...args], { encoding: 'utf8', env, stdio: ['ignore', 'pipe', 'pipe'] })
}

describe('Windows lab: the env files are locked for real (P5.4)', () => {
  it('new env files are locked (no inherited entry, no Users), and a rotation keeps the file ACL', () => {
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
    grant(web, '*S-1-5-19:R') // stands in for NT SERVICE\DrishtiWeb (LOCAL SERVICE)
    const before = parse(readFileSync(web, 'utf8')).CRON_SECRET
    run('--file', web, '--only=CRON_SECRET', '--rotate=CRON_SECRET')
    expect(parse(readFileSync(web, 'utf8')).CRON_SECRET).not.toBe(before)
    expect(icacls(web)).toMatch(/LOCAL SERVICE/)
    expect(icacls(web)).not.toMatch(/\(I\)/)
    expect(readdirSync(out).filter((f) => f.includes('.tmp-'))).toEqual([])
  })

  it('into an existing open folder the copies are made in a locked work folder; a file made there is closed from its creation', async () => {
    const open = path.join(dir, 'open')
    mkdirSync(open)
    grant(open, '*S-1-5-32-545:(OI)(CI)R') // Users may read: an unlocked folder
    const { lockedWorkDir } = await import('@/scripts/lib/win-acl.mjs')
    const before = process.env.DRISHTI_ACL_RECORD
    delete process.env.DRISHTI_ACL_RECORD
    try {
      const work = lockedWorkDir(open)
      const probe = path.join(work.dir, 'probe.tmp')
      writeFileSync(probe, '', { flag: 'wx' })
      expect(icacls(probe)).not.toMatch(/\\Users:|BUILTIN\\Users/i) // inherited from the locked work folder, not from the open one
      expect(icacls(work.dir)).not.toMatch(/\(I\)|\\Users:/i)
      work.done()
      expect(existsSync(work.dir)).toBe(false)
    } finally {
      if (before !== undefined) process.env.DRISHTI_ACL_RECORD = before
    }
    run('--production', '--out-dir', open, '--jwt-secret-env', 'GEN_TEST_JWT')
    for (const f of ['web.env', 'worker.env', 'gateway.env', 'go2rtc.env']) expect(icacls(path.join(open, f)), f).not.toMatch(/\(I\)|\\Users:/i)
    expect(readdirSync(open).filter((f) => f.startsWith('.gen-secrets-') || f.includes('.tmp-'))).toEqual([])
    run('--file', path.join(open, 'web.env'), '--only=CRON_SECRET', '--rotate=CRON_SECRET')
    expect(readdirSync(open).filter((f) => f.startsWith('.gen-secrets-') || f.includes('.tmp-'))).toEqual([])
  })

  it('every folder made for the env files is locked at once, not only the last one', () => {
    const top = path.join(dir, 'Drishti')
    const out = path.join(top, 'nested', 'config')
    run('--production', '--out-dir', out, '--jwt-secret-env', 'GEN_TEST_JWT')
    for (const p of [top, path.join(top, 'nested'), out]) {
      expect(icacls(p), p).not.toMatch(/\(I\)/)
      expect(icacls(p), p).not.toMatch(/Authenticated Users|\\Users:|Everyone/i)
    }
  })
})
