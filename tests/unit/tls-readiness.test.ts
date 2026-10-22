import { readFileSync } from 'node:fs'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import nextConfig from '../../next.config'
import { gatewayBindHost } from '@/lib/web/tls'
import { resolveGatewayBase } from '@/lib/streams/wall'
import { buildCsp, parseCsp } from '@/lib/web/csp'

// P3-1 brief item 4 (TLS readiness, Windows, one address): verified by tests because Caddy is not installed on this computer and
// nothing was downloaded or installed (see docs/drishti/runbook-tls.md). What is checked here: HSTS only on https, secure cookies on
// https (proxy-security.test.ts covers http-only), the gateway reachable under the same https address (wss://host/g/ws) with the policy
// allowing exactly that, the gateway able to listen on loopback only behind the reverse proxy, and the example Caddyfile routing it.

const ROOT = path.resolve(__dirname, '../..')
afterEach(() => vi.unstubAllEnvs())

const headersFor = async (appUrl: string) => {
  vi.stubEnv('NEXT_PUBLIC_APP_URL', appUrl)
  const rules = (await nextConfig.headers!()) as { source: string; headers: { key: string; value: string }[] }[]
  return rules.find((r) => r.source === '/:path*')!.headers
}

describe('TLS readiness', () => {
  it('HSTS only when the site is served over https', async () => {
    expect((await headersFor('https://drishti.citykart.local')).find((h) => h.key === 'Strict-Transport-Security')?.value).toBe('max-age=31536000')
    expect((await headersFor('http://10.0.0.47:3212')).some((h) => h.key === 'Strict-Transport-Security')).toBe(false)
  })

  it('behind one https address the gateway is wss on the same origin, and the policy allows exactly that (plus upgrade-insecure-requests)', () => {
    const page = { protocol: 'https:', host: 'drishti.citykart.local', hostname: 'drishti.citykart.local' }
    expect(resolveGatewayBase('/', page)).toBe('https://drishti.citykart.local')
    const p = parseCsp(buildCsp({ nonce: 'abc=', dev: false, page, gateway: '/', https: true }))
    expect(p['connect-src']).toEqual(["'self'", 'https://drishti.citykart.local', 'wss://drishti.citykart.local'])
    expect(p['upgrade-insecure-requests']).toEqual([])
  })

  it('the gateway listens on every address by default (as today) and on loopback when GATEWAY_HOST says so', () => {
    expect(gatewayBindHost({})).toBe('0.0.0.0')
    expect(gatewayBindHost({ GATEWAY_HOST: '127.0.0.1' })).toBe('127.0.0.1')
    expect(gatewayBindHost({ GATEWAY_HOST: '::1' })).toBe('::1')
    for (const bad of ['localhost; rm', 'example.com', '999.1.1.1', ' ']) expect(gatewayBindHost({ GATEWAY_HOST: bad }), bad).toBe('0.0.0.0')
    expect(readFileSync(path.join(ROOT, 'services/gateway/index.ts'), 'utf8')).toContain('gatewayBindHost(')
  })

  it('the example Caddyfile serves the app at / and the gateway under /g/* on the same address, with no key in the repository', () => {
    const caddy = readFileSync(path.join(ROOT, 'deploy/windows/Caddyfile.example'), 'utf8')
    expect(caddy).toMatch(/handle \/g\/\*\s*\{\s*reverse_proxy 127\.0\.0\.1:3412/)
    expect(caddy).toMatch(/handle\s*\{\s*reverse_proxy 127\.0\.0\.1:3212/)
    expect(caddy).not.toMatch(/BEGIN (RSA |EC )?PRIVATE KEY/)
    expect(readFileSync(path.join(ROOT, 'docs/drishti/runbook-tls.md'), 'utf8')).toContain('NEXT_PUBLIC_STREAM_GATEWAY_URL=/')
  })
})
