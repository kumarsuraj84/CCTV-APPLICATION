import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { readVerifiedUserId, signVerifiedUser, VERIFIED_USER_HEADER, VERIFIED_USER_SIG_HEADER } from '@/lib/auth/verified-user'

const headers = (o: Record<string, string>) => ({ get: (n: string) => o[n] ?? null })
// tests/setup/env.ts loads .env.local, which defines the real local key; every test starts without it and sets its own.
beforeEach(() => {
  delete process.env.SUPABASE_SERVICE_ROLE_KEY
})
afterEach(() => {
  delete process.env.SUPABASE_SERVICE_ROLE_KEY
})

describe('verified user header', () => {
  it('accepts a correctly signed id', () => {
    process.env.SUPABASE_SERVICE_ROLE_KEY = 'service-key-for-tests'
    const sig = signVerifiedUser('user-1')!
    expect(readVerifiedUserId(headers({ [VERIFIED_USER_HEADER]: 'user-1', [VERIFIED_USER_SIG_HEADER]: sig }))).toBe('user-1')
  })
  it('treats a forged signature as untrusted', () => {
    process.env.SUPABASE_SERVICE_ROLE_KEY = 'service-key-for-tests'
    expect(readVerifiedUserId(headers({ [VERIFIED_USER_HEADER]: 'user-1', [VERIFIED_USER_SIG_HEADER]: 'bad' }))).toBeUndefined()
  })
  it('reads an empty signed id as signed out', () => {
    process.env.SUPABASE_SERVICE_ROLE_KEY = 'service-key-for-tests'
    const sig = signVerifiedUser('')!
    expect(readVerifiedUserId(headers({ [VERIFIED_USER_HEADER]: '', [VERIFIED_USER_SIG_HEADER]: sig }))).toBeNull()
  })
  it('trusts nothing when no key is configured', () => {
    expect(signVerifiedUser('u')).toBeNull()
  })
})

// P2-6 (ARCHITECTURE caveat): the header is signed with its own secret (VERIFIED_USER_SECRET, purpose verified_user), no longer with the
// service key. Development without it falls back to the service key (the running app keeps working); production never does.
describe('verified user header key (P2-6)', () => {
  const KEY = 'v'.repeat(40)
  beforeEach(() => {
    delete process.env.VERIFIED_USER_SECRET
    vi.unstubAllEnvs()
  })
  afterEach(() => {
    delete process.env.VERIFIED_USER_SECRET
    vi.unstubAllEnvs()
  })

  it('uses VERIFIED_USER_SECRET when it is set, and a signature made with the service key no longer counts', () => {
    process.env.SUPABASE_SERVICE_ROLE_KEY = 'service-key-for-tests'
    const old = signVerifiedUser('user-1')!
    process.env.VERIFIED_USER_SECRET = KEY
    const sig = signVerifiedUser('user-1')!
    expect(sig).not.toBe(old)
    expect(readVerifiedUserId(headers({ [VERIFIED_USER_HEADER]: 'user-1', [VERIFIED_USER_SIG_HEADER]: sig }))).toBe('user-1')
    expect(readVerifiedUserId(headers({ [VERIFIED_USER_HEADER]: 'user-1', [VERIFIED_USER_SIG_HEADER]: old }))).toBeUndefined()
  })

  it('production never signs with the service key', () => {
    vi.stubEnv('NODE_ENV', 'production')
    process.env.SUPABASE_SERVICE_ROLE_KEY = 'service-key-for-tests'
    expect(signVerifiedUser('user-1')).toBeNull()
    process.env.VERIFIED_USER_SECRET = KEY
    expect(signVerifiedUser('user-1')).not.toBeNull()
  })
})
