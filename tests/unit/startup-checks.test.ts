import { randomBytes } from 'node:crypto'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { signServiceJwt } from '@/scripts/lib/service-jwt.mjs'
import { isProductionMode } from '@/lib/runtime-mode'
import { keyExpiryWarnings, startupProblems, watchKeyExpiry } from '@/lib/startup-checks'
import { serviceKeyFor } from '@/lib/supabase/service-clients'
import { connectRefusal } from '@/lib/security/targets'
import { secretWeakness, sharedSecret } from '@/lib/secrets'
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

// P5.4 brief item 3: production now also refuses a weak secret (one repeated character, a repeated pattern, a placeholder), so the
// fixtures are strong random-looking values (as gen-secrets makes: 43 characters of base64url), one per purpose.
const strong = (seed: string) => `${seed}-Qw7xK2pLm9Zr4Tb8Nc1Vh6Yd3Fs5Gj0Ek`.slice(0, 43)
const prodBase = {
  DRISHTI_ENV: 'production', NEXT_PUBLIC_SUPABASE_URL: 'https://db.example.test',
  STREAM_TOKEN_SECRET: strong('st'), ACCESS_PREVIEW_SECRET: strong('ap'), MERGE_CONFIRM_SECRET: strong('mc'), VERIFIED_USER_SECRET: strong('vu'),
  GO2RTC_API_USERNAME: 'drishti', GO2RTC_API_PASSWORD: strong('go'),
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

  it('P5.4: production refuses a needed secret under 32 characters (16 was enough before), naming it and never showing it', () => {
    const short = 'Qw7xK2pLm9Zr4Tb8Nc1Vh6Yd3Fs5' // 28 characters
    for (const [proc, env] of [['web', webEnv()], ['gateway', gatewayEnv()]] as const) {
      const r = startupProblems(proc, { ...env, STREAM_TOKEN_SECRET: short }, at)
      expect(r.problems.join(' '), proc).toMatch(/STREAM_TOKEN_SECRET.*32 characters/)
      expect(JSON.stringify(r)).not.toContain(short)
    }
    expect(startupProblems('web', { ...webEnv(), ACCESS_PREVIEW_SECRET: short }, at).problems.join(' ')).toContain('ACCESS_PREVIEW_SECRET')
    // Development keeps the old minimum and only warns.
    const dev = startupProblems('gateway', { SUPABASE_SERVICE_ROLE_KEY: 'svc', STREAM_TOKEN_SECRET: short }, at)
    expect(dev.problems).toEqual([])
  })

  it('P5.4: production refuses weak secrets (one character, a repeated pattern, a placeholder), naming each, never showing it', () => {
    // Review M-6: a human value with a repeated part of 6 or more characters (CityKart2026 twice) is weak too.
    for (const weak of ['s'.repeat(43), 'abcd'.repeat(11), 'change-me-change-me-change-me-change-me-1', 'your-secret-goes-here-0123456789-abcdefgh', 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaab1', 'CityKart2026CityKart2026Drishti!', 'Xk9-Drishti#Ops-71Drishti#Ops-qz4W']) {
      const r = startupProblems('web', { ...webEnv(), MERGE_CONFIRM_SECRET: weak }, at)
      expect(r.problems.join(' '), weak).toMatch(/MERGE_CONFIRM_SECRET.*(weak|guess)/)
      expect(JSON.stringify(r), weak).not.toContain(weak)
    }
    // A placeholder of x's as a part of its own is still one.
    expect(secretWeakness('token-xxxx-Qw7xK2pLm9Zr4Tb8Nc1Vh6Yd3Fs5Gj0')).toBe('looks like a placeholder')
    // ...while the generator's values (32 random bytes as base64url) are never refused: "xxXX" inside one is chance, not a placeholder.
    expect(secretWeakness('UA2qYvE77adXGQSfNqoKDaWjNrxxXXx5JBHRuDvVw9Q')).toBeNull()
    for (let i = 0; i < 2000; i++) {
      const v = randomBytes(32).toString('base64url')
      expect(secretWeakness(v), v).toBeNull()
    }
  })

  it('P5.4: production refuses the same value for two purposes (per-purpose secrets must be distinct), naming both', () => {
    const env = { ...webEnv(), ACCESS_PREVIEW_SECRET: prodBase.STREAM_TOKEN_SECRET }
    const p = startupProblems('web', env, at).problems.join(' ')
    expect(p).toMatch(/ACCESS_PREVIEW_SECRET/)
    expect(p).toMatch(/STREAM_TOKEN_SECRET/)
    expect(p).not.toContain(prodBase.STREAM_TOKEN_SECRET)
    // A secret the process does not need, but which is set, counts too (one value must never serve two purposes anywhere).
    expect(startupProblems('gateway', { ...gatewayEnv(), CRON_SECRET: prodBase.STREAM_TOKEN_SECRET }, at).problems.join(' ')).toMatch(/CRON_SECRET/)
    // go2rtc's API password is a secret like the others.
    expect(startupProblems('gateway', { ...gatewayEnv(), GO2RTC_API_PASSWORD: prodBase.STREAM_TOKEN_SECRET }, at).problems.join(' ')).toMatch(/GO2RTC_API_PASSWORD/)
  })

  it('development: no problem without the keys (the service key is the fallback), only warnings', () => {
    const r = startupProblems('gateway', { SUPABASE_SERVICE_ROLE_KEY: 'svc', STREAM_TOKEN_SECRET: 's'.repeat(43) }, at)
    expect(r.problems).toEqual([])
  })
})

// Release 1 clean-ups (P2-6 re-review N-1, N-2, N-4).
describe('release 1: the forgotten DRISHTI_ENV, the client address, keys that end while a process runs', () => {
  it('N-1: the production flag also fails closed for "Production", and an empty or blank value is development', () => {
    expect(isProductionMode({ DRISHTI_ENV: 'Production' })).toBe(true)
    expect(isProductionMode({ DRISHTI_ENV: ' production ' })).toBe(true)
    expect(isProductionMode({ DRISHTI_ENV: '' })).toBe(false)
    expect(isProductionMode({ DRISHTI_ENV: '   ' })).toBe(false)
  })

  it('N-1: without DRISHTI_ENV, a missing own key never falls back to the full service key when the database is not on this computer', () => {
    for (const url of ['https://abcd.supabase.co', 'http://10.0.0.47:54321', 'http://db.citykart.local:8000']) {
      for (const urlName of ['NEXT_PUBLIC_SUPABASE_URL', 'SUPABASE_URL']) {
        const k = serviceKeyFor('monitor_worker', { SUPABASE_SERVICE_ROLE_KEY: 'svc', [urlName]: url })
        expect(k.ok, `${urlName}=${url}`).toBe(false)
        if (!k.ok) {
          expect(k.error).toMatch(/SUPABASE_MONITOR_WORKER_KEY/)
          expect(k.error).toMatch(/DRISHTI_ENV=production/)
          expect(k.error).not.toContain('svc')
        }
      }
    }
    // The local stack (loopback) keeps the development fallback with its warning.
    for (const url of ['http://127.0.0.1:55321', 'http://localhost:54321', 'http://[::1]:54321']) {
      expect(serviceKeyFor('video_gateway', { SUPABASE_SERVICE_ROLE_KEY: 'svc', NEXT_PUBLIC_SUPABASE_URL: url }), url).toMatchObject({ ok: true, fallback: true })
    }
    // And so the start-up check of a worker with a remote database and no key reports it (a warning in development).
    const r = startupProblems('worker', { SUPABASE_SERVICE_ROLE_KEY: 'svc', NEXT_PUBLIC_SUPABASE_URL: 'https://abcd.supabase.co' }, at)
    expect(r.warnings.join(' ')).toMatch(/not on this computer/)
  })

  it('N-2: the production web app warns when TRUSTED_PROXY_HOPS is not set (no client address: no per-address ceiling)', () => {
    const blank = startupProblems('web', webEnv(), at)
    expect(blank.problems).toEqual([])
    expect(blank.warnings.join(' ')).toMatch(/TRUSTED_PROXY_HOPS/)
    expect(startupProblems('web', { ...webEnv(), TRUSTED_PROXY_HOPS: '0' }, at).warnings.join(' ')).toMatch(/TRUSTED_PROXY_HOPS/)
    expect(startupProblems('web', { ...webEnv(), TRUSTED_PROXY_HOPS: '1' }, at).warnings.join(' ')).not.toMatch(/TRUSTED_PROXY_HOPS/)
    // Not for the other processes, and not in development.
    expect(startupProblems('gateway', gatewayEnv(), at).warnings.join(' ')).not.toMatch(/TRUSTED_PROXY_HOPS/)
    expect(startupProblems('web', { SUPABASE_SERVICE_ROLE_KEY: 'svc' }, at).warnings.join(' ')).not.toMatch(/TRUSTED_PROXY_HOPS/)
  })

  // P5.4 fix round 3 (P5.5 report defect 1, handed over): behind the TLS proxy (GATEWAY_HOST on this computer) every video socket comes
  // from 127.0.0.1; without TRUSTED_PROXY_HOPS the gateway's per-address limits apply to everybody together.
  it('the production gateway behind the proxy warns when TRUSTED_PROXY_HOPS is not set', () => {
    for (const host of ['127.0.0.1', '::1', 'localhost']) {
      expect(startupProblems('gateway', { ...gatewayEnv(), GATEWAY_HOST: host }, at).warnings.join(' '), host).toMatch(/gateway.*TRUSTED_PROXY_HOPS=1/)
    }
    expect(startupProblems('gateway', { ...gatewayEnv(), GATEWAY_HOST: '127.0.0.1', TRUSTED_PROXY_HOPS: '1' }, at).warnings.join(' ')).not.toMatch(/TRUSTED_PROXY_HOPS/)
    expect(startupProblems('gateway', { ...gatewayEnv(), GATEWAY_HOST: '10.0.0.5' }, at).warnings.join(' ')).not.toMatch(/TRUSTED_PROXY_HOPS/)
    expect(startupProblems('gateway', { SUPABASE_SERVICE_ROLE_KEY: 'svc', GATEWAY_HOST: '127.0.0.1' }, at).warnings.join(' ')).not.toMatch(/TRUSTED_PROXY_HOPS/)
  })

  // P5.4 fix round 5 (final-fix-Y review R5): with an explicit wss/https video address the Health and Monitoring pages would ask the
  // gateway's /g/health through the TLS proxy, which does not pass it on: production warns unless GATEWAY_HEALTH_URL is set.
  it('the production web app warns when the video address is explicit and GATEWAY_HEALTH_URL is not set', () => {
    const explicit = { ...webEnv(), TRUSTED_PROXY_HOPS: '1', NEXT_PUBLIC_STREAM_GATEWAY_URL: 'wss://drishti.example.test' }
    expect(startupProblems('web', explicit, at).warnings.join(' ')).toMatch(/GATEWAY_HEALTH_URL=http:\/\/127\.0\.0\.1:3412/)
    expect(startupProblems('web', { ...explicit, GATEWAY_HEALTH_URL: 'http://127.0.0.1:3412' }, at).warnings.join(' ')).not.toMatch(/GATEWAY_HEALTH_URL/)
    for (const v of ['/', 'auto', '']) {
      expect(startupProblems('web', { ...explicit, NEXT_PUBLIC_STREAM_GATEWAY_URL: v }, at).warnings.join(' '), v).not.toMatch(/GATEWAY_HEALTH_URL/)
    }
  })

  it('N-4: keyExpiryWarnings names a key that ends within 30 days, and nothing else', () => {
    const soon = { ...workerEnv(), SUPABASE_MONITOR_WORKER_KEY: key('monitor_worker', 10 * 24 * 3600) }
    expect(keyExpiryWarnings('worker', soon, at).join(' ')).toMatch(/SUPABASE_MONITOR_WORKER_KEY ends in 10 days/)
    expect(keyExpiryWarnings('worker', workerEnv(), at)).toEqual([])
    expect(keyExpiryWarnings('worker', soon, at + 11 * 86_400_000).join(' ')).toMatch(/SUPABASE_MONITOR_WORKER_KEY has ended/)
  })

  it('N-4: a long-running process repeats the warning every day (not only at start-up), and the timer does not keep it alive', () => {
    vi.useFakeTimers()
    try {
      vi.setSystemTime(at)
      const env = { ...workerEnv(), SUPABASE_MONITOR_WORKER_KEY: key('monitor_worker', 40 * 24 * 3600) } // fine today, ends in 40 days
      const lines: string[] = []
      const stop = watchKeyExpiry('worker', { env, log: (m) => lines.push(m) })
      expect(lines).toEqual([]) // the start-up check already spoke
      vi.advanceTimersByTime(10 * 86_400_000)
      expect(lines).toEqual([]) // 30 days left: not yet
      vi.advanceTimersByTime(86_400_000)
      expect(lines.join(' ')).toMatch(/ends in 29 days/)
      vi.advanceTimersByTime(86_400_000)
      expect(lines).toHaveLength(2)
      stop()
      vi.advanceTimersByTime(5 * 86_400_000)
      expect(lines).toHaveLength(2)
    } finally {
      vi.useRealTimers()
    }
  })

  it('N-4: the worker, the gateway and the web app start the daily watch; the production web app logs its warnings too', () => {
    const read = (p: string) => readFileSync(path.resolve(__dirname, '../..', p), 'utf8')
    expect(read('services/worker/index.ts')).toContain("watchKeyExpiry('worker'")
    expect(read('services/gateway/index.ts')).toContain("watchKeyExpiry('gateway'")
    const web = read('lib/startup-web-run.ts')
    expect(web).toContain("watchKeyExpiry('web'")
    expect(web).toMatch(/startupProblems\('web', env\)\.warnings/)
  })
})
