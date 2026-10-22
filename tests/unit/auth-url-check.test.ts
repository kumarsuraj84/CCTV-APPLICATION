import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { authUrlProblem } from '@/lib/web/tls'

// P3-1 review I-5: the app's sign-in delay, its code count and "one app per person" hold only if nobody can reach the auth server
// (GoTrue, behind the Supabase API) directly. In production the web app refuses to start while the address it uses for Supabase is
// public: it must be this computer, the private network, or the app's own address behind the one reverse proxy.

const prod = { DRISHTI_ENV: 'production' }

describe('the Supabase / auth server address in production', () => {
  it('is fine on this computer, on the private network and behind the app’s own address', () => {
    for (const url of ['http://127.0.0.1:54321', 'http://localhost:55321', 'http://[::1]:54321', 'http://10.0.0.45:54321', 'http://192.168.1.10:8000',
      'http://172.20.0.5:8000', 'http://supabase:8000', 'http://db.citykart.local:8000', 'http://auth.corp.internal', 'http://[fd00::5]:54321']) {
      expect(authUrlProblem({ ...prod, NEXT_PUBLIC_SUPABASE_URL: url }), url).toBeNull()
    }
    expect(authUrlProblem({ ...prod, NEXT_PUBLIC_SUPABASE_URL: 'https://drishti.citykart.com/supabase', NEXT_PUBLIC_APP_URL: 'https://drishti.citykart.com' })).toBeNull()
  })

  it('refuses a public address (anyone could ask the auth server directly, around the app’s limits)', () => {
    for (const url of ['https://abcd.supabase.co', 'http://8.8.8.8:54321', 'https://auth.example.com', 'http://172.32.0.1:8000']) {
      expect(authUrlProblem({ ...prod, NEXT_PUBLIC_SUPABASE_URL: url }), url).toMatch(/runbook-tls\.md/)
    }
    expect(authUrlProblem({ ...prod, NEXT_PUBLIC_SUPABASE_URL: 'not a url' })).toMatch(/runbook-tls\.md/)
  })

  it('a hosted project with its network restrictions on is accepted only when the owner says so explicitly', () => {
    expect(authUrlProblem({ ...prod, NEXT_PUBLIC_SUPABASE_URL: 'https://abcd.supabase.co', DRISHTI_AUTH_URL_PUBLIC_OK: 'network-restricted' })).toBeNull()
    expect(authUrlProblem({ ...prod, NEXT_PUBLIC_SUPABASE_URL: 'https://abcd.supabase.co', DRISHTI_AUTH_URL_PUBLIC_OK: '1' })).not.toBeNull()
  })

  it('development is not checked', () => {
    expect(authUrlProblem({ NEXT_PUBLIC_SUPABASE_URL: 'https://abcd.supabase.co' })).toBeNull()
  })

  it('the web app’s production start-up check uses it', () => {
    expect(readFileSync(path.resolve(__dirname, '../../lib/startup-web.ts'), 'utf8')).toContain('authUrlProblem(')
  })
})
