import { afterEach, describe, expect, it } from 'vitest'
import { readVerifiedUserId, signVerifiedUser, VERIFIED_USER_HEADER, VERIFIED_USER_SIG_HEADER } from '@/lib/auth/verified-user'

const headers = (o: Record<string, string>) => ({ get: (n: string) => o[n] ?? null })
afterEach(() => delete process.env.SUPABASE_SERVICE_ROLE_KEY)

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
