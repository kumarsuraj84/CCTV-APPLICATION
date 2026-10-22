import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import type { Database } from '@/types/database'
import { adminClient, cleanupOrg, createOrg, createUser, type TestUser } from '../setup/fixtures'

// P3-1 brief item 7: the real sign-in and sign-out actions leave durable rows in auth_events (append-only): a sign-in with the person,
// a failed sign-in with the person found by the typed address and only a hash of it, a sign-out. Never the password. Only the Next
// request plumbing is replaced; the sign-in gate of P2-6 and the auth server are the real ones.

const m = vi.hoisted(() => ({ client: null as unknown }))
vi.mock('next/headers', () => ({ headers: async () => new Headers(), cookies: async () => ({ getAll: () => [], get: () => undefined, set: () => {} }) }))
vi.mock('next/cache', () => ({ revalidatePath: () => {} }))
vi.mock('@/lib/supabase/server', () => ({ createClient: async () => m.client as SupabaseClient<Database> }))

const fresh = () => createClient<Database>(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!, { auth: { persistSession: false, autoRefreshToken: false } })
const fd = (o: Record<string, string>) => {
  const f = new FormData()
  for (const [k, v] of Object.entries(o)) f.set(k, v)
  return f
}
const digest = (e: unknown) => String((e as { digest?: string })?.digest ?? e)

describe('sign-in audit (P3-1)', () => {
  let org: string
  let person: TestUser

  beforeAll(async () => {
    org = await createOrg()
    person = await createUser(org, 'user')
  })
  afterAll(() => cleanupOrg(org))

  it('a wrong password, a sign-in and a sign-out are recorded; no password is stored', async () => {
    const { signIn, signOut } = await import('@/lib/actions/auth')
    m.client = fresh()
    expect(await signIn({}, fd({ email: person.email.toUpperCase(), password: 'not-the-password-1A!' }))).toEqual({ error: 'Wrong e-mail or password.' })
    const c = fresh()
    m.client = c
    let redirected = ''
    try {
      await signIn({}, fd({ email: person.email, password: person.password, next: '/home' }))
    } catch (e) {
      redirected = digest(e)
    }
    expect(redirected).toContain('/home')
    try {
      await signOut()
    } catch (e) {
      expect(digest(e)).toContain('/login')
    }
    const { data } = await adminClient().from('auth_events').select('event, user_id, email_hash, detail').eq('user_id', person.id).order('at')
    const rows = data ?? []
    expect(rows.map((r) => r.event)).toEqual(['sign_in_failed', 'sign_in', 'sign_out'])
    expect(rows[0].email_hash).toMatch(/^[0-9a-f]{64}$/)
    const all = JSON.stringify(rows)
    expect(all).not.toContain(person.password)
    expect(all).not.toContain('not-the-password')
    expect(all).not.toContain(person.email)
  })
})
