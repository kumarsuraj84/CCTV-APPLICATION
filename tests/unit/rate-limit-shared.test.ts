import { describe, expect, it, vi } from 'vitest'
import { createSharedLimiter, LIMITS, limitKey, signInDelaySec, type LimiterStore } from '@/lib/rate-limit-shared'

// P2-6 brief item 6 (D-11, SO-7): one count for every app instance, kept in the database (rate_limit_hit: an atomic upsert per key and
// window), with a cheap in-process first filter in front. Here the database is a fake with the same semantics (the real function is
// proven in tests/integration/service-roles.test.ts); two limiter objects stand for two app instances.

function fakeStore(clock: { t: number }) {
  const rows = new Map<string, { hits: number; last: number }>()
  let down = false
  const k = (key: string, w: number) => `${key}|${w}|${Math.floor(clock.t / 1000 / w)}`
  const store: LimiterStore & { setDown(v: boolean): void; calls: number } = {
    calls: 0,
    setDown: (v) => (down = v),
    async hit(key, limit, windowSec) {
      store.calls++
      if (down) throw new Error('database unavailable')
      const r = rows.get(k(key, windowSec)) ?? { hits: 0, last: 0 }
      r.hits++
      r.last = clock.t
      rows.set(k(key, windowSec), r)
      return { allowed: r.hits <= limit, hits: r.hits, resetAt: (Math.floor(clock.t / 1000 / windowSec) + 1) * windowSec * 1000 }
    },
    async state(key, windowSec) {
      store.calls++
      if (down) throw new Error('database unavailable')
      const r = rows.get(k(key, windowSec))
      return { hits: r?.hits ?? 0, lastHitAt: r ? r.last : null }
    },
    async clear(key) {
      if (down) throw new Error('database unavailable')
      for (const name of [...rows.keys()]) if (name.startsWith(`${key}|`)) rows.delete(name)
    },
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

  it('after failures the next try must wait; a success forgets them; another address or person is not affected', async () => {
    const clock = { t: 1_800_000_000_000 }
    const l = createSharedLimiter(fakeStore(clock), () => clock.t)
    const who = '203.0.113.7|someone@example.test'
    for (let i = 0; i < 4; i++) await l.signInFailed(who)
    expect(await l.signInWait(who)).toBe(10)
    clock.t += 4_000
    expect(await l.signInWait(who)).toBe(6)
    clock.t += 6_000
    expect(await l.signInWait(who)).toBe(0) // may try again: no lockout
    expect(await l.signInWait('203.0.113.8|someone@example.test')).toBe(0)
    expect(await l.signInWait('203.0.113.7|other@example.test')).toBe(0)
    await l.signInSucceeded(who)
    expect(await l.signInWait(who)).toBe(0)
  })

  it('database down: a sign-in is refused with a short wait (fail closed), not let through unlimited', async () => {
    const clock = { t: 1_800_000_000_000 }
    const store = fakeStore(clock)
    store.setDown(true)
    vi.spyOn(console, 'log').mockImplementation(() => {})
    const l = createSharedLimiter(store, () => clock.t)
    expect(await l.signInWait('x|y@example.test')).toBeGreaterThan(0)
    vi.restoreAllMocks()
  })
})
