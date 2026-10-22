import { beforeEach, describe, expect, it, vi } from 'vitest'
import { MSG_LIMITER_UNAVAILABLE, MSG_SIGN_IN_BUSY, useLimiterStoreForTest } from '@/lib/rate-limit-shared'
import { memoryLimiterStore } from '../helpers/limiter-store'

// P2-6 review round 1, I-3 / I-4: the sign-in action with a fake sign-in service (GoTrue). Only a genuine refusal of the e-mail address
// and password counts as a wrong try; "busy" (429), a server error or no answer at all is not counted and says "try again in a moment".
// The attempt is counted atomically before the password is checked, so simultaneous tries get no more than the delay allows.

const auth = vi.hoisted(() => ({
  answer: async (): Promise<{ error: { status?: number; code?: string; name?: string; message: string } | null }> => ({ error: null }),
  calls: 0,
}))
vi.mock('next/navigation', () => ({
  redirect: vi.fn((to: string) => {
    throw Object.assign(new Error('NEXT_REDIRECT'), { to })
  }),
}))
vi.mock('@/lib/supabase/server', () => ({
  createClient: vi.fn(async () => ({
    auth: {
      signInWithPassword: async () => {
        auth.calls++
        return auth.answer()
      },
    },
  })),
}))
vi.mock('@/lib/rate-limit', () => ({ getClientIp: vi.fn(async () => '203.0.113.7') }))
vi.mock('@/lib/auth/profile', () => ({ getCurrentProfile: vi.fn(async () => null) }))

const { signIn } = await import('@/lib/actions/auth')

const form = (password = 'not-the-password') => {
  const f = new FormData()
  f.set('email', 'someone@example.test')
  f.set('password', password)
  return f
}
const wrong = { error: { status: 400, code: 'invalid_credentials', message: 'Invalid login credentials' } }
const run = async (f = form()) => {
  try {
    return await signIn({}, f)
  } catch (e) {
    if (e instanceof Error && e.message === 'NEXT_REDIRECT') return { redirected: true }
    throw e
  }
}

describe('sign-in action (review round 1, I-3 / I-4)', () => {
  const clock = { t: 1_800_000_000_000 }
  beforeEach(() => {
    clock.t = 1_800_000_000_000
    auth.calls = 0
    auth.answer = async () => wrong
    useLimiterStoreForTest(memoryLimiterStore(() => clock.t), () => clock.t)
    vi.spyOn(console, 'log').mockImplementation(() => {})
  })

  it('a wrong password is counted: three free tries, then a wait', async () => {
    for (let i = 0; i < 3; i++) expect(await run()).toEqual({ error: 'Wrong e-mail or password.' })
    expect(await run()).toEqual({ error: 'Too many wrong tries. Please wait 5 seconds and try again.' })
    expect(auth.calls).toBe(3)
  })

  it('I-4: the sign-in service answering 429 is "busy", not a wrong password, and is not counted', async () => {
    auth.answer = async () => ({ error: { status: 429, code: 'over_request_rate_limit', message: 'Request rate limit reached' } })
    for (let i = 0; i < 5; i++) expect(await run()).toEqual({ error: MSG_SIGN_IN_BUSY })
    // None of the five counted: three wrong passwords still reach the service before the first wait.
    auth.answer = async () => wrong
    for (let i = 0; i < 3; i++) expect(await run()).toEqual({ error: 'Wrong e-mail or password.' })
    expect(await run()).toMatchObject({ error: expect.stringContaining('Please wait') })
    expect(auth.calls).toBe(8)
  })

  it('I-4: a server error or no answer at all is "busy" and not counted either', async () => {
    auth.answer = async () => ({ error: { status: 503, message: 'Service Unavailable' } })
    expect(await run()).toEqual({ error: MSG_SIGN_IN_BUSY })
    auth.answer = async () => ({ error: { status: 0, name: 'AuthRetryableFetchError', message: 'fetch failed' } })
    expect(await run()).toEqual({ error: MSG_SIGN_IN_BUSY })
    auth.answer = async () => {
      throw new TypeError('fetch failed')
    }
    expect(await run()).toEqual({ error: MSG_SIGN_IN_BUSY })
    auth.answer = async () => wrong
    for (let i = 0; i < 3; i++) expect(await run()).toEqual({ error: 'Wrong e-mail or password.' })
  })

  it('I-3: twenty simultaneous tries after three failures: exactly one reaches the sign-in service', async () => {
    for (let i = 0; i < 3; i++) await run()
    clock.t += 6_000 // the 5-second delay has passed
    auth.calls = 0
    auth.answer = async () => {
      await new Promise((r) => setTimeout(r, 20)) // the password check takes a moment
      return wrong
    }
    const answers = await Promise.all(Array.from({ length: 20 }, () => run()))
    expect(auth.calls).toBe(1)
    expect(answers.filter((a) => 'error' in a && a.error === 'Wrong e-mail or password.')).toHaveLength(1)
    for (const a of answers) expect(a).toHaveProperty('error')
  })

  it('a correct password signs in and clears the count', async () => {
    for (let i = 0; i < 2; i++) await run()
    auth.answer = async () => ({ error: null })
    expect(await run(form('the-password'))).toEqual({ redirected: true })
    auth.answer = async () => wrong
    for (let i = 0; i < 3; i++) expect(await run()).toEqual({ error: 'Wrong e-mail or password.' })
  })

  it('the limiter cannot be asked: "try again in a moment", and the password is never checked', async () => {
    const down = memoryLimiterStore(() => clock.t)
    down.signInGate = async () => {
      throw new Error('database unavailable')
    }
    useLimiterStoreForTest(down, () => clock.t)
    expect(await run()).toEqual({ error: MSG_LIMITER_UNAVAILABLE })
    expect(auth.calls).toBe(0)
  })
})
