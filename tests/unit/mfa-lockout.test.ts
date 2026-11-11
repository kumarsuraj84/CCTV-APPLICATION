import { beforeEach, describe, expect, it, vi } from 'vitest'

// Final fix Y (review B I-2): the code step asks the database's count of consecutive failed codes before it checks a code, reports the
// outcome after, and refuses (fail closed) when the count cannot be read. The database side (limits, doubling, 100, concurrency) is in
// tests/integration/final-fix-y-db.test.ts.

const calls: { fn: string; args: Record<string, unknown> }[] = []
let beginAnswers: unknown[] = []
vi.mock('@/lib/auth/auth-events', () => ({ recordAuthEvent: vi.fn(async () => {}) }))
vi.mock('@/lib/auth/auth-limits', () => ({ authRefusal: vi.fn(async () => null) }))
vi.mock('@/lib/supabase/admin', () => ({ createAdminClient: () => web }))
const web = {
  rpc: vi.fn(async (fn: string, args: Record<string, unknown>) => {
    calls.push({ fn, args })
    if (fn === 'mfa_code_claim') return { data: true, error: null }
    if (fn === 'mfa_code_attempt_begin') {
      const a = beginAnswers.shift()
      return a instanceof Error ? { data: null, error: { code: 'XX000', message: 'down' } } : { data: a, error: null }
    }
    return { data: null, error: null }
  }),
}
const open = { allowed: true, locked_until: null, for_good: false, locks_if_wrong: false }
const me = { id: '11111111-1111-4111-8111-111111111111', email: 'p@example.test', session: { hasFactor: true, aal2: false } } as never
const client = (verify: { error: unknown }) => ({
  auth: { mfa: { listFactors: async () => ({ data: { totp: [{ id: 'f1', status: 'verified' }] }, error: null }), challengeAndVerify: vi.fn(async () => verify) } },
}) as never
const ends = () => calls.filter((c) => c.fn === 'mfa_code_attempt_end').map((c) => c.args.p_outcome)

describe('the code step and the count of wrong codes (final fix Y, B I-2)', () => {
  beforeEach(() => {
    calls.length = 0
    beginAnswers = []
  })

  it('a right code: counted first, then reported correct (the count resets)', async () => {
    const { verifySignInCode } = await import('@/lib/auth/mfa')
    beginAnswers = [open]
    expect(await verifySignInCode(client({ error: null }), me, '123456')).toEqual({ ok: true })
    expect(calls.map((c) => c.fn)).toEqual(['mfa_code_attempt_begin', 'mfa_code_claim', 'mfa_code_attempt_end'])
    expect(ends()).toEqual(['correct'])
  })

  it('a wrong code is reported wrong; an answer the auth server could not give is given back', async () => {
    const { verifySignInCode, MSG_BAD_CODE, MSG_TRY_AGAIN } = await import('@/lib/auth/mfa')
    beginAnswers = [open, open]
    expect(await verifySignInCode(client({ error: { code: 'mfa_verification_failed', message: 'Invalid TOTP code entered' } }), me, '123456')).toEqual({ ok: false, error: MSG_BAD_CODE })
    expect(await verifySignInCode(client({ error: { code: 'unexpected_failure', message: 'boom' } }), me, '123457')).toEqual({ ok: false, error: MSG_TRY_AGAIN })
    expect(ends()).toEqual(['wrong', 'not_counted'])
  })

  it('a locked code step: nothing is checked and the person reads until when (India time); locked for good says who unlocks it', async () => {
    const { verifySignInCode, MSG_CODES_LOCKED_FOR_GOOD } = await import('@/lib/auth/mfa')
    const c = client({ error: null })
    beginAnswers = [{ allowed: false, locked_until: '2026-11-11T08:35:00Z', for_good: false, locks_if_wrong: false }]
    const r = await verifySignInCode(c, me, '123456')
    expect(r).toEqual({ ok: false, error: expect.stringMatching(/locked until 14:05 \(India time\)/) })
    beginAnswers = [{ allowed: false, locked_until: null, for_good: true, locks_if_wrong: false }]
    expect(await verifySignInCode(c, me, '123456')).toEqual({ ok: false, error: MSG_CODES_LOCKED_FOR_GOOD })
    expect(calls.some((x) => x.fn === 'mfa_code_claim')).toBe(false)
    expect((c as unknown as { auth: { mfa: { challengeAndVerify: { mock: { calls: unknown[] } } } } }).auth.mfa.challengeAndVerify.mock.calls).toHaveLength(0)
  })

  it('the wrong code that locks the step says so at once', async () => {
    const { verifySignInCode } = await import('@/lib/auth/mfa')
    beginAnswers = [{ ...open, locks_if_wrong: true }, { allowed: false, locked_until: '2026-11-11T08:35:00Z', for_good: false, locks_if_wrong: false }]
    const r = await verifySignInCode(client({ error: { code: 'mfa_verification_failed', message: 'Invalid TOTP code entered' } }), me, '123456')
    expect(r).toEqual({ ok: false, error: expect.stringMatching(/locked until 14:05/) })
  })

  it('the count cannot be read: refused, no code is checked (fail closed)', async () => {
    const { verifySignInCode, MSG_TRY_AGAIN } = await import('@/lib/auth/mfa')
    beginAnswers = [new Error('down')]
    expect(await verifySignInCode(client({ error: null }), me, '123456')).toEqual({ ok: false, error: MSG_TRY_AGAIN })
    expect(calls.map((c) => c.fn)).toEqual(['mfa_code_attempt_begin'])
  })
})
