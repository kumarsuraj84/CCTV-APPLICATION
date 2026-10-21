import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { auditSecrets, getSecret, MIN_SECRET_LENGTH } from '@/lib/secrets'

const KEYS = ['CRON_SECRET', 'WORKER_SECRET', 'STREAM_TOKEN_SECRET', 'SYSTEM_LOG_INGEST_SECRET']
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
      STREAM_TOKEN_SECRET: 'c'.repeat(20), SYSTEM_LOG_INGEST_SECRET: 'd'.repeat(20),
    }
    expect(auditSecrets(env)).toEqual([])
  })
})
