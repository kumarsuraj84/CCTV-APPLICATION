import { describe, expect, it } from 'vitest'
import { signServiceJwt } from '@/scripts/lib/service-jwt.mjs'
import { isProductionMode } from '@/lib/runtime-mode'
import { startupProblems } from '@/lib/startup-checks'
import { serviceKeyFor } from '@/lib/supabase/service-clients'
import { connectRefusal } from '@/lib/security/targets'
import { sharedSecret } from '@/lib/secrets'
import { isDemoRecorder } from '@/lib/streams/source'

// P2-6 review round 1, I-1 / I-2 / M-4 / M-16: production must not depend on NODE_ENV alone (the worker and the gateway run under tsx,
// which sets no NODE_ENV). DRISHTI_ENV=production (set by the Windows service environment and deploy/production.env.example) puts
// every process into production mode; there a missing per-service key, the old service key, a go2rtc API without its login, an
// expired key or a loopback target refuses the start with a plain message. Development stays as it was (fallback with a warning).

const SECRET = 'a-test-jwt-secret-that-is-long-enough-1234567890'
const NOW = 1_800_000_000
const key = (role: 'app_web' | 'media_service' | 'monitor_worker' | 'video_gateway', lifetimeSec = 365 * 24 * 3600) =>
  signServiceJwt(SECRET, role, { now: NOW, lifetimeSec })
const at = NOW * 1000

const prodBase = {
  DRISHTI_ENV: 'production', NEXT_PUBLIC_SUPABASE_URL: 'https://db.example.test',
  STREAM_TOKEN_SECRET: 's'.repeat(43), ACCESS_PREVIEW_SECRET: 'p'.repeat(43), MERGE_CONFIRM_SECRET: 'm'.repeat(43), VERIFIED_USER_SECRET: 'v'.repeat(43),
  GO2RTC_API_USERNAME: 'drishti', GO2RTC_API_PASSWORD: 'g'.repeat(43),
}
const webEnv = () => ({ ...prodBase, SUPABASE_APP_WEB_KEY: key('app_web'), SUPABASE_MEDIA_SERVICE_KEY: key('media_service'), SUPABASE_SERVICE_ROLE_KEY: 'service-key-for-gotrue-admin' })
const workerEnv = () => ({ DRISHTI_ENV: 'production', NEXT_PUBLIC_SUPABASE_URL: 'https://db.example.test', SUPABASE_MONITOR_WORKER_KEY: key('monitor_worker') })
const gatewayEnv = () => ({ ...prodBase, SUPABASE_VIDEO_GATEWAY_KEY: key('video_gateway') })

describe('the production mode flag', () => {
  it('is DRISHTI_ENV=production, or NODE_ENV=production; any other DRISHTI_ENV value than "development" also counts (fail closed)', () => {
    expect(isProductionMode({ DRISHTI_ENV: 'production' })).toBe(true)
    expect(isProductionMode({ NODE_ENV: 'production' })).toBe(true)
    expect(isProductionMode({ DRISHTI_ENV: 'prod' })).toBe(true)
    expect(isProductionMode({ DRISHTI_ENV: 'development' })).toBe(false)
    expect(isProductionMode({})).toBe(false) // tsx without NODE_ENV, development
    expect(isProductionMode({ NODE_ENV: 'development', DRISHTI_ENV: 'production' })).toBe(true)
  })

  it('every switch that used to look at NODE_ENV follows it: the service-key fallback, loopback, per-process keys, the demo picture', () => {
    const prod = { DRISHTI_ENV: 'production' } // no NODE_ENV, as under tsx
    expect(serviceKeyFor('monitor_worker', { ...prod, SUPABASE_SERVICE_ROLE_KEY: 'svc' }).ok).toBe(false)
    expect(connectRefusal('127.0.0.1', prod)).not.toBeNull()
    expect(sharedSecret('merge_confirm', prod)).toBeNull()
    expect(isDemoRecorder({ host: '127.0.0.1' }, { ...prod, DEMO_VIDEO: '1' })).toBe(false)
    // Development is unchanged.
    expect(serviceKeyFor('monitor_worker', { SUPABASE_SERVICE_ROLE_KEY: 'svc' })).toMatchObject({ ok: true, fallback: true })
    expect(connectRefusal('127.0.0.1', {})).toBeNull()
  })
})

describe('startupProblems', () => {
  it('a complete production environment has no problem for any process', () => {
    expect(startupProblems('web', webEnv(), at).problems).toEqual([])
    expect(startupProblems('worker', workerEnv(), at).problems).toEqual([])
    expect(startupProblems('gateway', gatewayEnv(), at).problems).toEqual([])
  })

  it('production: a missing own key refuses the start (never the old service key), naming the key and never showing a value', () => {
    const w = { ...workerEnv(), SUPABASE_MONITOR_WORKER_KEY: '', SUPABASE_SERVICE_ROLE_KEY: 'the-old-full-key' }
    const r = startupProblems('worker', w, at)
    expect(r.problems.join(' ')).toContain('SUPABASE_MONITOR_WORKER_KEY')
    expect(JSON.stringify(r)).not.toContain('the-old-full-key')
    const g = { ...gatewayEnv(), SUPABASE_VIDEO_GATEWAY_KEY: undefined }
    expect(startupProblems('gateway', g, at).problems.join(' ')).toContain('SUPABASE_VIDEO_GATEWAY_KEY')
    const web = { ...webEnv(), SUPABASE_MEDIA_SERVICE_KEY: key('app_web') } // a key for another role
    expect(startupProblems('web', web, at).problems.join(' ')).toContain('SUPABASE_MEDIA_SERVICE_KEY')
  })

  it('production: the worker and the gateway must not even hold the old service key', () => {
    expect(startupProblems('worker', { ...workerEnv(), SUPABASE_SERVICE_ROLE_KEY: 'x' }, at).problems.join(' ')).toContain('SUPABASE_SERVICE_ROLE_KEY')
    expect(startupProblems('gateway', { ...gatewayEnv(), SUPABASE_SERVICE_ROLE_KEY: 'x' }, at).problems.join(' ')).toContain('SUPABASE_SERVICE_ROLE_KEY')
  })

  it('I-2: production without go2rtc\'s API login (or with a password under 32 characters) refuses the web app and the gateway', () => {
    for (const proc of ['web', 'gateway'] as const) {
      const base = proc === 'web' ? webEnv() : gatewayEnv()
      for (const change of [{ GO2RTC_API_USERNAME: '' }, { GO2RTC_API_PASSWORD: '' }, { GO2RTC_API_PASSWORD: 'g'.repeat(31) }]) {
        const p = startupProblems(proc, { ...base, ...change }, at).problems.join(' ')
        expect(p, `${proc} ${JSON.stringify(change)}`).toContain('GO2RTC_API')
      }
    }
  })

  it('production: loopback targets and the demo picture refuse the start', () => {
    expect(startupProblems('worker', { ...workerEnv(), OUTBOUND_TARGET_ALLOWLIST: '127.0.0.1:8081' }, at).problems.join(' ')).toContain('OUTBOUND_TARGET_ALLOWLIST')
    expect(startupProblems('web', { ...webEnv(), OUTBOUND_TARGET_ALLOWLIST: '192.168.5.5:161,169.254.169.254:80' }, at).problems.join(' ')).toContain('OUTBOUND_TARGET_ALLOWLIST')
    expect(startupProblems('web', { ...webEnv(), DEMO_VIDEO: '1' }, at).problems.join(' ')).toContain('DEMO_VIDEO')
    expect(startupProblems('web', { ...webEnv(), OUTBOUND_TARGET_ALLOWLIST: '192.168.5.5:161' }, at).problems).toEqual([])
  })

  it('production web app: the shared secrets it cannot run without', () => {
    for (const k of ['STREAM_TOKEN_SECRET', 'ACCESS_PREVIEW_SECRET', 'MERGE_CONFIRM_SECRET', 'VERIFIED_USER_SECRET']) {
      expect(startupProblems('web', { ...webEnv(), [k]: '' }, at).problems.join(' '), k).toContain(k)
    }
  })

  it('M-4: an expired key refuses the start; one ending within 30 days warns (in development too)', () => {
    const expired = { ...workerEnv(), SUPABASE_MONITOR_WORKER_KEY: key('monitor_worker', 60) }
    expect(startupProblems('worker', expired, at + 120_000).problems.join(' ')).toMatch(/SUPABASE_MONITOR_WORKER_KEY.*ended/)
    const soon = { ...workerEnv(), SUPABASE_MONITOR_WORKER_KEY: key('monitor_worker', 10 * 24 * 3600) }
    const r = startupProblems('worker', soon, at)
    expect(r.problems).toEqual([])
    expect(r.warnings.join(' ')).toMatch(/SUPABASE_MONITOR_WORKER_KEY.*10 days/)
    const dev = startupProblems('worker', { SUPABASE_MONITOR_WORKER_KEY: key('monitor_worker', 10 * 24 * 3600) }, at)
    expect(dev.problems).toEqual([])
    expect(dev.warnings.length).toBe(1)
  })

  it('development: no problem without the keys (the service key is the fallback), only warnings', () => {
    const r = startupProblems('gateway', { SUPABASE_SERVICE_ROLE_KEY: 'svc', STREAM_TOKEN_SECRET: 's'.repeat(43) }, at)
    expect(r.problems).toEqual([])
  })
})
