import { describe, expect, it } from 'vitest'
import { buildCsp, cspExtraOrigins, cspHeaderName, makeNonce, parseCsp, REDIRECT_CSP } from '@/lib/web/csp'

// P3-1 brief item 2 (D-12, SO-8): a nonce-based Content Security Policy built per request. The live wall must keep working: its only
// extra connect target is the video gateway (derived from NEXT_PUBLIC_STREAM_GATEWAY_URL, or from the page host in development).

const hub = { protocol: 'http:', host: '10.0.0.47:3212', hostname: '10.0.0.47' }
const local = { protocol: 'http:', host: 'localhost:3212', hostname: 'localhost' }
const tls = { protocol: 'https:', host: 'drishti.citykart.local', hostname: 'drishti.citykart.local' }
const base = { nonce: 'bm9uY2Utdmx1ZQ==', dev: false, page: hub, gateway: undefined as string | undefined }

describe('the nonce', () => {
  it('is 128 random bits in base64, new for every request', () => {
    const a = makeNonce()
    const b = makeNonce()
    expect(a).toMatch(/^[A-Za-z0-9+/]{22}==$/)
    expect(a).not.toBe(b)
  })
})

describe('the production policy', () => {
  const p = parseCsp(buildCsp(base))

  it('runs only scripts with this request’s nonce (and what they load), never inline handlers or eval', () => {
    expect(p['script-src']).toEqual(["'self'", "'nonce-bm9uY2Utdmx1ZQ=='", "'strict-dynamic'"])
    expect(p['script-src']).not.toContain("'unsafe-inline'")
    expect(p['script-src']).not.toContain("'unsafe-eval'")
  })

  it('locks down everything else', () => {
    expect(p['default-src']).toEqual(["'self'"])
    expect(p['object-src']).toEqual(["'none'"])
    expect(p['base-uri']).toEqual(["'self'"])
    expect(p['form-action']).toEqual(["'self'"])
    expect(p['frame-ancestors']).toEqual(["'none'"])
    expect(p['frame-src']).toEqual(["'none'"])
    expect(p['img-src']).toEqual(["'self'", 'data:', 'blob:'])
    expect(p['media-src']).toEqual(["'self'", 'blob:'])
    expect(p['font-src']).toEqual(["'self'"])
    expect(p['worker-src']).toEqual(["'self'"])
    expect(p['manifest-src']).toEqual(["'self'"])
    // Styles: React writes style attributes and the toast library adds its own style sheet, which a nonce cannot cover.
    expect(p['style-src']).toEqual(["'self'", "'unsafe-inline'"])
    expect(p['report-uri']).toEqual(['/api/csp-report'])
  })

  it('the gateway (same host as the page, port 3412) is the only extra connect target', () => {
    expect(p['connect-src']).toEqual(["'self'", 'http://10.0.0.47:3412', 'ws://10.0.0.47:3412'])
    expect(parseCsp(buildCsp({ ...base, page: local }))['connect-src']).toEqual(["'self'", 'http://localhost:3412', 'ws://localhost:3412'])
  })

  it('an explicit gateway address is used as it is; a configured port and a path behind the same address are followed', () => {
    expect(parseCsp(buildCsp({ ...base, gateway: 'http://10.0.0.5:3412' }))['connect-src']).toEqual(["'self'", 'http://10.0.0.5:3412', 'ws://10.0.0.5:3412'])
    expect(parseCsp(buildCsp({ ...base, gateway: 'auto', gatewayPort: '4000' }))['connect-src']).toEqual(["'self'", 'http://10.0.0.47:4000', 'ws://10.0.0.47:4000'])
    expect(parseCsp(buildCsp({ ...base, page: tls, gateway: '/' }))['connect-src']).toEqual(["'self'", 'https://drishti.citykart.local', 'wss://drishti.citykart.local'])
    // A "this computer" address opened from another PC follows the page host, as the browser does (lib/streams/wall.ts).
    expect(parseCsp(buildCsp({ ...base, gateway: 'http://localhost:3412' }))['connect-src']).toEqual(["'self'", 'http://10.0.0.47:3412', 'ws://10.0.0.47:3412'])
  })

  it('adds only well-formed origins from the optional allow-list, never a wildcard, path or scheme-only source', () => {
    const extra = 'https://maps.example.com, wss://events.example.com:8443 ,*,https://*.example.com,http://x/y?z,javascript:alert(1),data:,ws:,  '
    expect(cspExtraOrigins(extra)).toEqual(['https://maps.example.com', 'wss://events.example.com:8443'])
    expect(parseCsp(buildCsp({ ...base, extraConnect: extra }))['connect-src']).toEqual([
      "'self'", 'http://10.0.0.47:3412', 'ws://10.0.0.47:3412', 'https://maps.example.com', 'wss://events.example.com:8443',
    ])
    expect(cspExtraOrigins(undefined)).toEqual([])
  })

  it('a bad gateway setting adds nothing (the wall then says video is not available)', () => {
    expect(parseCsp(buildCsp({ ...base, gateway: 'ftp://x' }))['connect-src']).toEqual(["'self'"])
  })

  it('upgrades insecure requests only on https', () => {
    expect(p['upgrade-insecure-requests']).toBeUndefined()
    expect(parseCsp(buildCsp({ ...base, page: tls, https: true }))['upgrade-insecure-requests']).toEqual([])
  })

  it('holds no line breaks, and a nonce with anything but base64 characters is refused', () => {
    expect(buildCsp(base)).not.toMatch(/[\r\n]/)
    for (const nonce of ['', "x' 'unsafe-inline", 'a;b', 'a b']) expect(() => buildCsp({ ...base, nonce }), nonce).toThrow()
  })
})

describe('the development policy (hot reload keeps working)', () => {
  const p = parseCsp(buildCsp({ ...base, page: local, dev: true }))
  it('allows eval for React’s debugging and the hot-reload socket of the page’s own host', () => {
    expect(p['script-src']).toEqual(["'self'", "'nonce-bm9uY2Utdmx1ZQ=='", "'strict-dynamic'", "'unsafe-eval'"])
    expect(p['connect-src']).toEqual(["'self'", 'http://localhost:3412', 'ws://localhost:3412', 'ws://localhost:3212'])
  })
  it('is otherwise as strict as production', () => {
    expect(p['object-src']).toEqual(["'none'"])
    expect(p['frame-ancestors']).toEqual(["'none'"])
  })
})

describe('report-only rollout and redirects', () => {
  it('the header name follows the switch', () => {
    expect(cspHeaderName(false)).toBe('Content-Security-Policy')
    expect(cspHeaderName(true)).toBe('Content-Security-Policy-Report-Only')
  })
  it('a redirect answer gets a policy that allows nothing at all (it has no content)', () => {
    const r = parseCsp(REDIRECT_CSP)
    expect(r['default-src']).toEqual(["'none'"])
    expect(r['frame-ancestors']).toEqual(["'none'"])
    expect(r['base-uri']).toEqual(["'none'"])
    expect(r['form-action']).toEqual(["'none'"])
  })
})
