import { readFileSync } from 'node:fs'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

// P3-1 review I-1: every sign-in cookie is HttpOnly, SameSite=Lax and (on https) Secure, whoever writes it: the cookie client of
// Server Actions and route handlers (sign-in, the code step, "Confirm it's you", set-up, password change, the reset link's callback)
// AND the proxy's refresh. @supabase/ssr defaults to httpOnly: false. One helper sets the options for both.

const store = vi.hoisted(() => ({ sets: [] as { name: string; value: string; options: Record<string, unknown> }[], config: null as null | { cookies: { setAll: (l: unknown[]) => void } } }))
vi.mock('next/headers', () => ({ cookies: async () => ({ getAll: () => [], set: (name: string, value: string, options: Record<string, unknown>) => store.sets.push({ name, value, options }) }) }))
vi.mock('@supabase/ssr', () => ({
  createServerClient: (_u: string, _k: string, config: never) => {
    store.config = config
    return {}
  },
}))

const ROOT = path.resolve(__dirname, '../..')
afterEach(() => {
  vi.unstubAllEnvs()
  store.sets = []
})

describe('authCookieOptions', () => {
  it('forces HttpOnly and SameSite=Lax, keeps path and lifetime, and adds Secure only on https', async () => {
    const { authCookieOptions } = await import('@/lib/supabase/cookie-options')
    expect(authCookieOptions({ path: '/', maxAge: 100, httpOnly: false, sameSite: 'none' }, false)).toEqual({ path: '/', maxAge: 100, httpOnly: true, sameSite: 'lax' })
    expect(authCookieOptions({ path: '/', maxAge: 0 }, true)).toEqual({ path: '/', maxAge: 0, httpOnly: true, sameSite: 'lax', secure: true })
    expect(authCookieOptions(undefined, false)).toEqual({ httpOnly: true, sameSite: 'lax' })
  })
})

describe('the cookie client (every Server Action and route handler)', () => {
  it('writes sign-in cookies HttpOnly and Lax over http, and Secure as well over https', async () => {
    const { createClient } = await import('@/lib/supabase/server')
    vi.stubEnv('NEXT_PUBLIC_APP_URL', 'http://10.0.0.47:3212')
    await createClient()
    store.config!.cookies.setAll([{ name: 'sb-localhost-auth-token', value: 'v', options: { path: '/', httpOnly: false, sameSite: 'lax', maxAge: 400 } }])
    expect(store.sets).toEqual([{ name: 'sb-localhost-auth-token', value: 'v', options: { path: '/', httpOnly: true, sameSite: 'lax', maxAge: 400 } }])
    store.sets = []
    vi.stubEnv('NEXT_PUBLIC_APP_URL', 'https://drishti.citykart.local')
    await createClient()
    store.config!.cookies.setAll([{ name: 'sb-x-auth-token', value: '', options: { path: '/', maxAge: 0 } }])
    expect(store.sets[0].options).toEqual({ path: '/', maxAge: 0, httpOnly: true, sameSite: 'lax', secure: true })
  })

  it('the proxy and the cookie client use the same helper (no second copy of the rule)', () => {
    for (const f of ['proxy.ts', 'lib/supabase/server.ts']) expect(readFileSync(path.join(ROOT, f), 'utf8'), f).toContain('authCookieOptions(')
  })
})
