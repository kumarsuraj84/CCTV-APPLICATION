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
    const who = `198.51.100.9|${randomUUID()}@example.test`
    for (let i = 0; i < 3; i++) await a.signInFailed(who)
    const wait = await b.signInWait(who)
    expect(wait).toBeGreaterThan(0)
    expect(wait).toBeLessThanOrEqual(5)
    await b.signInSucceeded(who)
    expect(await a.signInWait(who)).toBe(0)
  })

  it('a database that cannot be reached: sensitive actions refused, video reads allowed within the in-process limit', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {})
    const port = await closedPort()
    const down = createClient<Database>(`http://127.0.0.1:${port}`, 'x.y.z', { auth: { persistSession: false } })
    const l = createSharedLimiter(databaseStore(() => down))
    expect(await l.hit('admin_action', 'p')).toMatchObject({ allowed: false, reason: 'unavailable' })
    expect(await l.hit('import_apply', 'p')).toMatchObject({ allowed: false, reason: 'unavailable' })
    expect((await l.hit('live_open', 'p')).allowed).toBe(true)
    expect(await l.signInWait('p|q@example.test')).toBeGreaterThan(0)
    vi.restoreAllMocks()
  })
})
