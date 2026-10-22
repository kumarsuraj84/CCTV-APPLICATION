import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { auditSecrets, getSecret, MIN_SECRET_LENGTH, secretEnvName, sharedSecret } from '@/lib/secrets'

const KEYS = ['CRON_SECRET', 'WORKER_SECRET', 'STREAM_TOKEN_SECRET', 'SYSTEM_LOG_INGEST_SECRET', 'ACCESS_PREVIEW_SECRET']
// tests/setup/env.ts loads .env.local, which may already define some of these; start from a clean slate.
beforeEach(() => KEYS.forEach((k) => delete process.env[k]))
afterEach(() => KEYS.forEach((k) => delete process.env[k]))

describe('secrets', () => {
  it('returns null when a secret is missing or blank, and never another purpose’s value', () => {
    process.env.CRON_SECRET = 'cron-secret-value-123'
    expect(getSecret('worker')).toBeNull()
    process.env.WORKER_SECRET = '   '
    expect(getSecret('worker')).toBeNull()
    expect(getSecret('cron')).toBe('cron-secret-value-123')
  })

  it('treats a secret shorter than the minimum as not set, for every purpose', () => {
    for (const [env, purpose] of [['CRON_SECRET', 'cron'], ['WORKER_SECRET', 'worker'], ['STREAM_TOKEN_SECRET', 'stream_token'], ['SYSTEM_LOG_INGEST_SECRET', 'system_log_ingest'], ['ACCESS_PREVIEW_SECRET', 'access_preview']] as const) {
      process.env[env] = 'a'.repeat(MIN_SECRET_LENGTH - 1)
      expect(getSecret(purpose), purpose).toBeNull()
      process.env[env] = 'a'.repeat(MIN_SECRET_LENGTH)
      expect(getSecret(purpose), purpose).toBe('a'.repeat(MIN_SECRET_LENGTH))
      delete process.env[env]
    }
  })

  it('reports missing, short and duplicated secrets without printing values', () => {
    const same = 'abcdefghijklmnopqrst'
    const env = { CRON_SECRET: same, WORKER_SECRET: same, STREAM_TOKEN_SECRET: 'short' }
    const issues = auditSecrets(env)
    const text = JSON.stringify(issues)
    expect(issues.some((i) => i.env === 'WORKER_SECRET' && i.problem.startsWith('the same value as'))).toBe(true)
    expect(issues.some((i) => i.env === 'STREAM_TOKEN_SECRET' && i.problem.includes(String(MIN_SECRET_LENGTH)))).toBe(true)
    expect(issues.some((i) => i.env === 'SYSTEM_LOG_INGEST_SECRET' && i.problem === 'not set')).toBe(true)
    expect(text).not.toContain(same)
  })

  it('has no issues when every secret is set, long and different', () => {
    const env = {
      CRON_SECRET: 'a'.repeat(20), WORKER_SECRET: 'b'.repeat(20),
      STREAM_TOKEN_SECRET: 'c'.repeat(20), SYSTEM_LOG_INGEST_SECRET: 'd'.repeat(20), ACCESS_PREVIEW_SECRET: 'e'.repeat(20),
    }
    expect(auditSecrets(env)).toEqual([])
  })
})

// P2-6 brief item 7 and addendum: the purposes of the coming packages, each with its own environment key, a minimum length of 32 for the
// new ones and the same uniqueness rule; a shared secret (so several app instances agree) with a per-process key only outside production.
describe('secret purposes (P2-6)', () => {
  const NEW = ['MERGE_CONFIRM_SECRET', 'VERIFIED_USER_SECRET', 'GO2RTC_API_PASSWORD', 'SIGNER_SECRET', 'AGENT_INGEST_SECRET', 'AUDIT_CHECKPOINT_SECRET']
  beforeEach(() => NEW.forEach((k) => delete process.env[k]))
  afterEach(() => NEW.forEach((k) => delete process.env[k]))

  it('names one environment key per purpose', () => {
    expect([
      secretEnvName('merge_confirm'), secretEnvName('verified_user'), secretEnvName('go2rtc_api'),
      secretEnvName('signer'), secretEnvName('agent_ingest'), secretEnvName('audit_checkpoint'),
    ]).toEqual(NEW)
  })

  it('the new purposes need at least 32 characters', () => {
    for (const [env, purpose] of [['MERGE_CONFIRM_SECRET', 'merge_confirm'], ['SIGNER_SECRET', 'signer'], ['AGENT_INGEST_SECRET', 'agent_ingest'], ['AUDIT_CHECKPOINT_SECRET', 'audit_checkpoint'], ['VERIFIED_USER_SECRET', 'verified_user'], ['GO2RTC_API_PASSWORD', 'go2rtc_api']] as const) {
      process.env[env] = 'x'.repeat(31)
      expect(getSecret(purpose), purpose).toBeNull()
      process.env[env] = 'x'.repeat(32)
      expect(getSecret(purpose), purpose).toBe('x'.repeat(32))
      delete process.env[env]
    }
  })

  it('reports a new secret that is too short or the same as another, but not one that is simply not set yet', () => {
    const same = 'q'.repeat(40)
    const issues = auditSecrets({ CRON_SECRET: same, WORKER_SECRET: 'w'.repeat(20), STREAM_TOKEN_SECRET: 's'.repeat(20), SYSTEM_LOG_INGEST_SECRET: 'l'.repeat(20), ACCESS_PREVIEW_SECRET: 'p'.repeat(20), MERGE_CONFIRM_SECRET: same, SIGNER_SECRET: 'short-but-16-chars' })
    expect(issues.map((i) => i.env).sort()).toEqual(['MERGE_CONFIRM_SECRET', 'SIGNER_SECRET'])
    expect(JSON.stringify(issues)).not.toContain(same)
  })

  it('a shared secret is the configured one (every instance agrees); without it, one key per process outside production, none in production', () => {
    process.env.MERGE_CONFIRM_SECRET = 'm'.repeat(40)
    expect(sharedSecret('merge_confirm', { NODE_ENV: 'production', MERGE_CONFIRM_SECRET: 'm'.repeat(40) })).toBe('m'.repeat(40))
    const dev1 = sharedSecret('merge_confirm', { NODE_ENV: 'development' })
    const dev2 = sharedSecret('merge_confirm', { NODE_ENV: 'development' })
    expect(dev1).not.toBeNull()
    expect(dev1).toBe(dev2) // the same key for the whole process
    expect(dev1!.length).toBeGreaterThanOrEqual(32)
    expect(sharedSecret('merge_confirm', { NODE_ENV: 'production' })).toBeNull()
  })
})
