import { describe, expect, it, vi } from 'vitest'
import {
  createSharedLimiter, LIMITS, limitKey, MSG_LIMITER_UNAVAILABLE, MSG_SIGN_IN_BUSY, SIGN_IN_IP_LIMIT, signInDelaySec, signInOutcomeOf,
  signInRefusalMessage, type LimiterStore,
} from '@/lib/rate-limit-shared'
import { memoryLimiterStore } from '../helpers/limiter-store'

// P2-6 brief item 6 (D-11, SO-7): one count for every app instance, kept in the database (rate_limit_hit: an atomic upsert per key and
// window), with a cheap in-process first filter in front. Here the database is a fake with the same semantics (the real function is
// proven in tests/integration/service-roles.test.ts); two limiter objects stand for two app instances.

/** The in-memory store with the database's semantics (tests/helpers/limiter-store.ts), counting calls and able to go down. */
function fakeStore(clock: { t: number }) {
  const inner = memoryLimiterStore(() => clock.t)
  let down = false
  const wrap = <A extends unknown[], R>(f: (...a: A) => Promise<R>) => (...a: A): Promise<R> => {
    store.calls++
    if (down) return Promise.reject(new Error('database unavailable'))
    return f(...a)
  }
  const store: LimiterStore & { setDown(v: boolean): void; calls: number } = {
    calls: 0,
    setDown: (v) => (down = v),
    hit: wrap(inner.hit),
    state: wrap(inner.state),
    clear: wrap(inner.clear),
    signInGate: wrap(inner.signInGate),
    signInFinish: wrap(inner.signInFinish),
  }
  return store
}

describe('shared rate limiter', () => {
  it('two app instances share one count', async () => {
    const clock = { t: 1_800_000_000_000 }
    const store = fakeStore(clock)
    const a = createSharedLimiter(store, () => clock.t)
    const b = createSharedLimiter(store, () => clock.t)
    const limit = LIMITS.connection_test.limit
    const answers = []
    for (let i = 0; i < limit + 4; i++) answers.push(await (i % 2 ? a : b).hit('connection_test', 'person-1'))
    expect(answers.filter((x) => x.allowed)).toHaveLength(limit)
    expect(answers.at(-1)).toMatchObject({ allowed: false, reason: 'limit' })
  })

  it('a new window starts a new count', async () => {
    const clock = { t: 1_800_000_000_000 }
    const l = createSharedLimiter(fakeStore(clock), () => clock.t)
    const { limit, windowSec } = LIMITS.merge_preview
    for (let i = 0; i < limit; i++) expect((await l.hit('merge_preview', 'p')).allowed).toBe(true)
    expect((await l.hit('merge_preview', 'p')).allowed).toBe(false)
    clock.t += windowSec * 1000
    expect((await l.hit('merge_preview', 'p')).allowed).toBe(true)
  })

  it('keys are counted apart: another person, another limit', async () => {
    const clock = { t: 1_800_000_000_000 }
    const l = createSharedLimiter(fakeStore(clock), () => clock.t)
    for (let i = 0; i < LIMITS.import_apply.limit; i++) await l.hit('import_apply', 'p1')
    expect((await l.hit('import_apply', 'p1')).allowed).toBe(false)
    expect((await l.hit('import_apply', 'p2')).allowed).toBe(true)
    expect((await l.hit('import_check', 'p1')).allowed).toBe(true)
  })

  it('keys never hold the person, e-mail address or IP in clear', () => {
    const key = limitKey('sign_in_failures', '203.0.113.7|someone@example.test')
    expect(key).toMatch(/^sign_in_failures:[0-9a-f]{32}$/)
    expect(key).not.toContain('example')
    expect(key).not.toContain('203.0.113')
  })

  it('the in-process first filter refuses without asking the database once this instance is over the limit', async () => {
    const clock = { t: 1_800_000_000_000 }
    const store = fakeStore(clock)
    const l = createSharedLimiter(store, () => clock.t)
    const { limit } = LIMITS.discover_all
    for (let i = 0; i < limit; i++) await l.hit('discover_all', 'p')
    const before = store.calls
    expect((await l.hit('discover_all', 'p')).allowed).toBe(false)
    expect(store.calls).toBe(before)
  })

  it('database down: sensitive actions are refused, reads keep the in-process limit', async () => {
    const clock = { t: 1_800_000_000_000 }
    const store = fakeStore(clock)
    store.setDown(true)
    vi.spyOn(console, 'log').mockImplementation(() => {})
    const l = createSharedLimiter(store, () => clock.t)
    for (const name of ['admin_action', 'import_apply', 'connection_test', 'change_password', 'forgot_password'] as const) {
      expect(await l.hit(name, 'p'), name).toMatchObject({ allowed: false, reason: 'unavailable' })
    }
    for (const name of ['live_open', 'playback_open', 'playback_lookup', 'vod_open'] as const) expect((await l.hit(name, 'p')).allowed, name).toBe(true)
    // ...but never more than the in-process limit.
    let allowed = 1
    for (let i = 0; i < LIMITS.live_open.limit + 5; i++) if ((await l.hit('live_open', 'p')).allowed) allowed++
    expect(allowed).toBe(LIMITS.live_open.limit)
    vi.restoreAllMocks()
  })

  it('a legitimate 36-tile wall renewing every minute (with retries every 30 s and three tabs open) is never throttled', async () => {
    const clock = { t: 1_800_000_000_000 }
    const l = createSharedLimiter(fakeStore(clock), () => clock.t)
    let refused = 0
    // Ten minutes, three tabs: each tab renews its 36 tokens once a minute in ONE call, and asks again for the cameras that failed every 30 s.
    for (let s = 0; s < 600; s += 30) {
      clock.t = 1_800_000_000_000 + s * 1000
      for (let tab = 0; tab < 3; tab++) {
        if (!(await l.hit('live_open', 'viewer-1')).allowed) refused++ // the retry
        if (s % 60 === 0 && !(await l.hit('live_open', 'viewer-1')).allowed) refused++ // the renewal
      }
    }
    expect(refused).toBe(0)
  })
})

describe('sign-in: rising delays keyed by e-mail address and IP (no hard lockout)', () => {
  it('no wait for the first failures, then a rising wait, capped at five minutes', () => {
    expect([0, 1, 2].map(signInDelaySec)).toEqual([0, 0, 0])
    expect(signInDelaySec(3)).toBe(5)
    expect(signInDelaySec(4)).toBe(10)
    expect(signInDelaySec(5)).toBe(20)
    expect(signInDelaySec(50)).toBe(300)
  })

  // Every attempt is counted as a failure when it is let through (before the password is checked); a success clears the count.
  const fail = async (l: ReturnType<typeof createSharedLimiter>, email: string, ip: string | null) => {
    const g = await l.signInGate(email, ip)
    if (!g.allowed) throw new Error(`refused: ${g.reason}`)
    await g.finish('refused')
  }

  it('after failures the next try must wait; a success forgets them; another address or person is not affected', async () => {
    const clock = { t: 1_800_000_000_000 }
    const l = createSharedLimiter(fakeStore(clock), () => clock.t)
    for (let i = 0; i < 4; i++) {
      await fail(l, 'someone@example.test', '203.0.113.7')
      clock.t += 30_000 // each later try waits out the delay of the ones before
    }
    clock.t -= 30_000
    expect(await l.signInGate('someone@example.test', '203.0.113.7')).toMatchObject({ allowed: false, reason: 'wait', waitSec: 10 })
    clock.t += 4_000
    expect(await l.signInGate('someone@example.test', '203.0.113.7')).toMatchObject({ allowed: false, reason: 'wait', waitSec: 6 })
    expect((await l.signInGate('someone@example.test', '203.0.113.8')).allowed).toBe(true) // another IP
    expect((await l.signInGate('other@example.test', '203.0.113.7')).allowed).toBe(true) // another person
    clock.t += 6_000
    const g = await l.signInGate('someone@example.test', '203.0.113.7') // may try again: no lockout
    expect(g.allowed).toBe(true)
    if (g.allowed) await g.finish('succeeded')
    for (let i = 0; i < 3; i++) await fail(l, 'someone@example.test', '203.0.113.7') // the count starts again from nothing
  })

  it('review I-3: the attempt is counted in the same atomic step as the check, so a burst gets no more than one delay period allows', async () => {
    const clock = { t: 1_800_000_000_000 }
    const store = fakeStore(clock)
    // Twenty app instances (no shared in-process filter): only the database's atomic gate stands between them and the password check.
    const instances = Array.from({ length: 20 }, () => createSharedLimiter(store, () => clock.t))
    const burst = () => Promise.all(instances.map((l) => l.signInGate('victim@example.test', '203.0.113.7')))
    // A fresh address: the three free tries, then the delay.
    expect((await burst()).filter((g) => g.allowed)).toHaveLength(3)
    // Three failures and the delay passed: exactly one of twenty simultaneous tries reaches the password check.
    clock.t += 6_000
    expect((await burst()).filter((g) => g.allowed)).toHaveLength(1)
    clock.t += 11_000
    expect((await burst()).filter((g) => g.allowed)).toHaveLength(1)
  })

  it('review I-3: in one instance, a try for the same address and IP while one is in flight is refused without asking the database', async () => {
    const clock = { t: 1_800_000_000_000 }
    const store = fakeStore(clock)
    const l = createSharedLimiter(store, () => clock.t)
    const all = await Promise.all(Array.from({ length: 20 }, () => l.signInGate('victim@example.test', '203.0.113.7')))
    expect(all.filter((g) => g.allowed)).toHaveLength(1)
    expect(all.filter((g) => !g.allowed && g.reason === 'busy')).toHaveLength(19)
    expect(store.calls).toBe(1)
    const first = all.find((g) => g.allowed)
    if (first?.allowed) await first.finish('refused')
    // A known wait is remembered in the instance: the next tries are refused without asking the database again.
    await fail(l, 'victim@example.test', '203.0.113.7')
    await fail(l, 'victim@example.test', '203.0.113.7')
    expect((await l.signInGate('victim@example.test', '203.0.113.7')).allowed).toBe(false)
    const calls = store.calls
    expect(await l.signInGate('victim@example.test', '203.0.113.7')).toMatchObject({ allowed: false, reason: 'wait' })
    expect(store.calls).toBe(calls)
  })

  it('review I-4: an attempt the sign-in service could not answer (busy, down) is given back, not counted as a wrong password', async () => {
    const clock = { t: 1_800_000_000_000 }
    const l = createSharedLimiter(fakeStore(clock), () => clock.t)
    for (let i = 0; i < 10; i++) {
      const g = await l.signInGate('someone@example.test', '203.0.113.7')
      expect(g.allowed, `try ${i}`).toBe(true)
      if (g.allowed) await g.finish('not_counted')
    }
    for (let i = 0; i < 3; i++) await fail(l, 'someone@example.test', '203.0.113.7')
    expect(await l.signInGate('someone@example.test', '203.0.113.7')).toMatchObject({ allowed: false, reason: 'wait', waitSec: 5 })
  })

  it('review I-4: which answers of the sign-in service count as a wrong password', () => {
    expect(signInOutcomeOf(null)).toBe('succeeded')
    expect(signInOutcomeOf({ status: 400, code: 'invalid_credentials' })).toBe('refused')
    expect(signInOutcomeOf({ status: 400, code: 'email_not_confirmed' })).toBe('refused')
    expect(signInOutcomeOf({ status: 429, code: 'over_request_rate_limit' })).toBe('not_counted')
    expect(signInOutcomeOf({ status: 500 })).toBe('not_counted')
    expect(signInOutcomeOf({ status: 503 })).toBe('not_counted')
    expect(signInOutcomeOf({ status: 0, name: 'AuthRetryableFetchError' })).toBe('not_counted') // network
    expect(signInOutcomeOf({ name: 'AuthUnknownError' })).toBe('not_counted')
  })

  it('a known client IP has a ceiling of tries over all e-mail addresses; without a known IP there is no shared ceiling', async () => {
    const clock = { t: 1_800_000_000_000 }
    const l = createSharedLimiter(fakeStore(clock), () => clock.t)
    for (let i = 0; i < SIGN_IN_IP_LIMIT; i++) await fail(l, `p${i}@example.test`, '203.0.113.9')
    expect(await l.signInGate('another@example.test', '203.0.113.9')).toMatchObject({ allowed: false, reason: 'ip' })
    expect((await l.signInGate('another@example.test', '203.0.113.10')).allowed).toBe(true)
    // "noip" (no trusted proxy configured): every client would share one ceiling — a lockout of everybody — so there is none.
    for (let i = 0; i < SIGN_IN_IP_LIMIT + 20; i++) await fail(l, `q${i}@example.test`, null)
  })

  it('the plain words for each refusal', () => {
    expect(signInRefusalMessage({ allowed: false, reason: 'wait', waitSec: 1 })).toBe('Too many wrong tries. Please wait 1 second and try again.')
    expect(signInRefusalMessage({ allowed: false, reason: 'wait', waitSec: 20 })).toBe('Too many wrong tries. Please wait 20 seconds and try again.')
    expect(signInRefusalMessage({ allowed: false, reason: 'busy', waitSec: 1 })).toBe(MSG_SIGN_IN_BUSY)
    expect(signInRefusalMessage({ allowed: false, reason: 'unavailable', waitSec: 30 })).toBe(MSG_LIMITER_UNAVAILABLE)
    expect(signInRefusalMessage({ allowed: false, reason: 'ip', waitSec: 600 })).toMatch(/from this network.*10 minutes/)
  })

  it('database down: a sign-in is refused with "try again in a moment" (fail closed), not let through and not "too many wrong tries"', async () => {
    const clock = { t: 1_800_000_000_000 }
    const store = fakeStore(clock)
    store.setDown(true)
    vi.spyOn(console, 'log').mockImplementation(() => {})
    const l = createSharedLimiter(store, () => clock.t)
    const g = await l.signInGate('y@example.test', '203.0.113.7')
    expect(g).toMatchObject({ allowed: false, reason: 'unavailable' })
    // The in-flight mark is gone: once the database is back, the next try is asked normally.
    store.setDown(false)
    expect((await l.signInGate('y@example.test', '203.0.113.7')).allowed).toBe(true)
    vi.restoreAllMocks()
  })
})
