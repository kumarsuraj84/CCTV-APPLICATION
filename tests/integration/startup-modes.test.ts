import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { signServiceJwt } from '@/scripts/lib/service-jwt.mjs'

// P2-6 review round 1, I-1 / I-2: the worker and the gateway run under tsx, which sets no NODE_ENV. With DRISHTI_ENV=production they
// must refuse to start (exit 1, a plain line naming what is missing, no value) instead of falling back to the full service key. The
// processes are started for real (tsx, as `npm run worker` / `npm run gateway` do), in an empty folder (no .env.local is read), with a
// minimal environment; every case refuses before any network connection, so nothing is contacted.

const ROOT = path.resolve(__dirname, '../..')
const TSX = path.join(ROOT, 'node_modules', 'tsx', 'dist', 'cli.mjs')
const dir = mkdtempSync(path.join(os.tmpdir(), 'drishti-startup-'))
afterAll(() => rmSync(dir, { recursive: true, force: true }))

const SECRET = 'a-test-jwt-secret-that-is-long-enough-1234567890'
// P5.4: production refuses weak or repeated secrets, so the fixtures are strong, distinct values (as gen-secrets makes).
const STREAM = 'st-Qw7xK2pLm9Zr4Tb8Nc1Vh6Yd3Fs5Gj0Ek-aaaaaa'.slice(0, 43)
const GO2RTC = 'go-Qw7xK2pLm9Zr4Tb8Nc1Vh6Yd3Fs5Gj0Ek-bbbbbb'.slice(0, 43)
const base = () => ({ PATH: process.env.PATH ?? '', SystemRoot: process.env.SystemRoot ?? '', TEMP: os.tmpdir(), TMP: os.tmpdir() })

function run(script: 'worker' | 'gateway', env: Record<string, string>): Promise<{ code: number | null; out: string }> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [TSX, '--tsconfig', path.join(ROOT, 'tsconfig.json'), path.join(ROOT, 'services', script, 'index.ts')], {
      cwd: dir, env: { ...base(), ...env } as unknown as NodeJS.ProcessEnv, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true,
    })
    let out = ''
    child.stdout.on('data', (d: Buffer) => (out += d.toString()))
    child.stderr.on('data', (d: Buffer) => (out += d.toString()))
    const timer = setTimeout(() => child.kill(), 20_000)
    child.on('close', (code: number | null) => {
      clearTimeout(timer)
      resolve({ code, out })
    })
  })
}

describe('worker and gateway start-up in production mode (DRISHTI_ENV, no NODE_ENV)', () => {
  it('the worker refuses without its own key even when the old service key is there, and never prints a key', async () => {
    const r = await run('worker', { DRISHTI_ENV: 'production', NEXT_PUBLIC_SUPABASE_URL: 'http://127.0.0.1:1', SUPABASE_SERVICE_ROLE_KEY: 'the-old-full-service-key' })
    expect(r.code).toBe(1)
    expect(r.out).toContain('SUPABASE_MONITOR_WORKER_KEY')
    expect(r.out).not.toContain('the-old-full-service-key')
  }, 30_000)

  it('the gateway refuses without its own key', async () => {
    const r = await run('gateway', {
      DRISHTI_ENV: 'production', SUPABASE_URL: 'http://127.0.0.1:1', SUPABASE_SERVICE_ROLE_KEY: 'the-old-full-service-key', STREAM_TOKEN_SECRET: STREAM,
      GATEWAY_ALLOWED_ORIGINS: 'http://localhost:3212', GO2RTC_API_USERNAME: 'drishti', GO2RTC_API_PASSWORD: GO2RTC,
    })
    expect(r.code).toBe(1)
    expect(r.out).toContain('SUPABASE_VIDEO_GATEWAY_KEY')
    expect(r.out).not.toContain('the-old-full-service-key')
  }, 30_000)

  it('the gateway refuses without go2rtc\'s API login (I-2), with its own key present', async () => {
    const r = await run('gateway', {
      DRISHTI_ENV: 'production', SUPABASE_URL: 'http://127.0.0.1:1', STREAM_TOKEN_SECRET: STREAM, GATEWAY_ALLOWED_ORIGINS: 'http://localhost:3212',
      SUPABASE_VIDEO_GATEWAY_KEY: signServiceJwt(SECRET, 'video_gateway'),
    })
    expect(r.code).toBe(1)
    expect(r.out).toContain('GO2RTC_API_USERNAME')
  }, 30_000)

  it('the gateway refuses a production address other than this computer (final fix Y, review B minor 3)', async () => {
    const r = await run('gateway', {
      DRISHTI_ENV: 'production', SUPABASE_URL: 'http://127.0.0.1:1', STREAM_TOKEN_SECRET: STREAM, GATEWAY_ALLOWED_ORIGINS: 'https://drishti.example.test',
      SUPABASE_VIDEO_GATEWAY_KEY: signServiceJwt(SECRET, 'video_gateway'), GO2RTC_API_USERNAME: 'drishti', GO2RTC_API_PASSWORD: GO2RTC, GATEWAY_HOST: '0.0.0.0',
    })
    expect(r.code).toBe(1)
    expect(r.out).toContain('GATEWAY_HOST must be 127.0.0.1')
  }, 30_000)

  it('the gateway refuses when go2rtc answers without its login (start-up probe)', async () => {
    const http = await import('node:http')
    const open = http.createServer((_q, res) => { res.setHeader('content-type', 'application/json'); res.end('{}') })
    const port = await new Promise<number>((resolve) => open.listen(0, '127.0.0.1', () => resolve((open.address() as { port: number }).port)))
    try {
      const r = await run('gateway', {
        DRISHTI_ENV: 'production', SUPABASE_URL: 'http://127.0.0.1:1', STREAM_TOKEN_SECRET: STREAM, GATEWAY_ALLOWED_ORIGINS: 'http://localhost:3212',
        SUPABASE_VIDEO_GATEWAY_KEY: signServiceJwt(SECRET, 'video_gateway'), GO2RTC_URL: `http://127.0.0.1:${port}`,
        GO2RTC_API_USERNAME: 'drishti', GO2RTC_API_PASSWORD: GO2RTC,
        // Final fix Y (review B minor 3): production gateways listen on this computer only (else refused before the go2rtc probe).
        GATEWAY_HOST: '127.0.0.1',
      })
      expect(r.code).toBe(1)
      expect(r.out).toContain('without its login')
    } finally {
      open.close()
    }
  }, 30_000)
})
