import { randomUUID } from 'node:crypto'
import { createClient } from '@supabase/supabase-js'
import { describe, expect, it, vi } from 'vitest'
import type { Database } from '@/types/database'
import { createSharedLimiter, databaseStore, LIMITS } from '@/lib/rate-limit-shared'
import { closedPort } from '../helpers/fake-servers'
import { serviceClient } from '../setup/service-keys'

// P2-6 (D-11, SO-7): the shared limiter on the real database, as the web app's own role (app_web). Two limiter objects are two app
// instances: one count between them. A database that cannot be reached: sensitive actions refused, video reads within the local limit.

describe('shared rate limiter on the database (P2-6)', () => {
  it('two app instances share one count through rate_limit_hit', async () => {
    const a = createSharedLimiter(databaseStore(() => serviceClient('app_web')))
    const b = createSharedLimiter(databaseStore(() => serviceClient('app_web')))
    const person = `person-${randomUUID()}`
    const { limit } = LIMITS.connection_test
    const answers = await Promise.all(Array.from({ length: limit + 6 }, (_, i) => (i % 2 ? a : b).hit('connection_test', person)))
    expect(answers.filter((x) => x.allowed)).toHaveLength(limit)
  })

  it('sign-in failures make the next try wait (no lockout) and a success clears them, across instances', async () => {
    const a = createSharedLimiter(databaseStore(() => serviceClient('app_web')))
    const b = createSharedLimiter(databaseStore(() => serviceClient('app_web')))
    const email = `${randomUUID()}@example.test`
    for (let i = 0; i < 3; i++) {
      const g = await a.signInGate(email, '198.51.100.9')
      expect(g.allowed).toBe(true)
      if (g.allowed) await g.finish('refused')
    }
    const refused = await b.signInGate(email, '198.51.100.9')
    expect(refused).toMatchObject({ allowed: false, reason: 'wait' })
    if (!refused.allowed) expect(refused.waitSec).toBeLessThanOrEqual(5)
    await new Promise((r) => setTimeout(r, 6_000))
    const ok = await b.signInGate(email, '198.51.100.9')
    expect(ok.allowed).toBe(true)
    if (ok.allowed) await ok.finish('succeeded')
    const again = await a.signInGate(email, '198.51.100.9')
    expect(again.allowed).toBe(true)
    if (again.allowed) await again.finish('succeeded')
  }, 20_000)

  it('review I-3: simultaneous tries from separate instances pass the database gate only as often as the delay allows', async () => {
    const instances = Array.from({ length: 20 }, () => createSharedLimiter(databaseStore(() => serviceClient('app_web'))))
    const email = `${randomUUID()}@example.test`
    const burst = async () => {
      const gates = await Promise.all(instances.map((l) => l.signInGate(email, '198.51.100.10')))
      for (const g of gates) if (g.allowed) await g.finish('refused')
      return gates
    }
    // A fresh address: the three free tries are counted before any of them is checked, so exactly three pass; the rest must wait.
    const first = await burst()
    expect(first.filter((g) => g.allowed)).toHaveLength(3)
    expect(first.filter((g) => !g.allowed && g.reason === 'wait')).toHaveLength(17)
    // Within the delay: none passes.
    expect((await burst()).filter((g) => g.allowed)).toHaveLength(0)
    // After the 5-second delay: exactly one of twenty passes.
    await new Promise((r) => setTimeout(r, 6_000))
    expect((await burst()).filter((g) => g.allowed)).toHaveLength(1)
  }, 30_000)

  it('review I-4: an attempt given back (the sign-in service was busy) is not counted', async () => {
    const l = createSharedLimiter(databaseStore(() => serviceClient('app_web')))
    const email = `${randomUUID()}@example.test`
    for (let i = 0; i < 6; i++) {
      const g = await l.signInGate(email, null)
      expect(g.allowed, `try ${i}`).toBe(true)
      if (g.allowed) await g.finish('not_counted')
    }
  })

  it('a database that cannot be reached: sensitive actions refused, video reads allowed within the in-process limit', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {})
    const port = await closedPort()
    const down = createClient<Database>(`http://127.0.0.1:${port}`, 'x.y.z', { auth: { persistSession: false } })
    const l = createSharedLimiter(databaseStore(() => down))
    expect(await l.hit('admin_action', 'p')).toMatchObject({ allowed: false, reason: 'unavailable' })
    expect(await l.hit('import_apply', 'p')).toMatchObject({ allowed: false, reason: 'unavailable' })
    expect((await l.hit('live_open', 'p')).allowed).toBe(true)
    expect(await l.signInGate('q@example.test', 'p')).toMatchObject({ allowed: false, reason: 'unavailable' })
    vi.restoreAllMocks()
  })
})
