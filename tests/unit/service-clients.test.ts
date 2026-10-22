import { afterEach, describe, expect, it, vi } from 'vitest'
import { SERVICE_KEY_ENV as SCRIPT_ENV, signServiceJwt } from '@/scripts/lib/service-jwt.mjs'
import { SERVICE_KEY_ENV, serviceKeyFor } from '@/lib/supabase/service-clients'

// P2-6 (D-14): every server process uses its own database key. Development falls back to the service key with a loud warning when a
// key is missing (so the owner's running processes keep working until the keys are added); production refuses.

const SECRET = 'a-test-jwt-secret-that-is-long-enough-1234567890'
const key = (role: 'app_web' | 'media_service' | 'monitor_worker' | 'video_gateway') => signServiceJwt(SECRET, role, { now: 1_800_000_000 })
const SERVICE = 'service-role-key-value-for-the-test'

afterEach(() => vi.restoreAllMocks())

describe('serviceKeyFor', () => {
  it('names one environment key per role, the same in the app and in the script that makes them', () => {
    expect(SERVICE_KEY_ENV).toEqual({
      app_web: 'SUPABASE_APP_WEB_KEY', media_service: 'SUPABASE_MEDIA_SERVICE_KEY', monitor_worker: 'SUPABASE_MONITOR_WORKER_KEY', video_gateway: 'SUPABASE_VIDEO_GATEWAY_KEY',
    })
    expect(SCRIPT_ENV).toEqual(SERVICE_KEY_ENV)
  })

  it('uses the role\'s own key when it is set and names that role', () => {
    for (const role of ['app_web', 'media_service', 'monitor_worker', 'video_gateway'] as const) {
      const own = key(role)
      const env = { [SERVICE_KEY_ENV[role]]: own, SUPABASE_SERVICE_ROLE_KEY: SERVICE, NODE_ENV: 'production' }
      expect(serviceKeyFor(role, env)).toEqual({ ok: true, key: own, fallback: false })
    }
  })

  it('refuses a key made for another role, without showing either key', () => {
    const wrong = key('app_web')
    const r = serviceKeyFor('video_gateway', { SUPABASE_VIDEO_GATEWAY_KEY: wrong, SUPABASE_SERVICE_ROLE_KEY: SERVICE, NODE_ENV: 'development' })
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.error).toContain('SUPABASE_VIDEO_GATEWAY_KEY')
    expect(r.error).not.toContain(wrong)
    expect(r.error).not.toContain(SERVICE)
  })

  it('refuses something that is not a key at all', () => {
    expect(serviceKeyFor('app_web', { SUPABASE_APP_WEB_KEY: 'not-a-jwt', NODE_ENV: 'development', SUPABASE_SERVICE_ROLE_KEY: SERVICE }).ok).toBe(false)
  })

  it('development without the key: the service key, marked as a fallback', () => {
    expect(serviceKeyFor('monitor_worker', { SUPABASE_SERVICE_ROLE_KEY: SERVICE, NODE_ENV: 'development' })).toEqual({ ok: true, key: SERVICE, fallback: true })
    expect(serviceKeyFor('monitor_worker', { SUPABASE_SERVICE_ROLE_KEY: SERVICE })).toEqual({ ok: true, key: SERVICE, fallback: true })
    expect(serviceKeyFor('monitor_worker', { SUPABASE_MONITOR_WORKER_KEY: '  ', SUPABASE_SERVICE_ROLE_KEY: SERVICE })).toEqual({ ok: true, key: SERVICE, fallback: true })
  })

  it('production without the key: refused, naming the key to add (never falls back to the service key)', () => {
    const r = serviceKeyFor('media_service', { SUPABASE_SERVICE_ROLE_KEY: SERVICE, NODE_ENV: 'production' })
    expect(r).toEqual({ ok: false, error: expect.stringContaining('SUPABASE_MEDIA_SERVICE_KEY') })
    expect(JSON.stringify(r)).not.toContain(SERVICE)
  })

  it('no key at all: refused', () => {
    expect(serviceKeyFor('app_web', { NODE_ENV: 'development' }).ok).toBe(false)
  })
})
