import { beforeEach, describe, expect, it, vi } from 'vitest'

// P3-1 brief item 2: the browser's reports of what the policy blocked (or would block, in report-only mode) are logged for the rollout:
// which directive and the blocked origin only — never a full address (a video socket address carries a token) — and size-limited.

const logged = vi.hoisted(() => [] as Record<string, unknown>[])
vi.mock('@/lib/observability/logger', () => ({ logger: { warn: (o: Record<string, unknown>) => logged.push(o), info: () => {}, error: () => {} } }))

const { POST } = await import('@/app/api/csp-report/route')
const { summariseReport } = await import('@/lib/web/csp-report')

const req = (body: string, type = 'application/csp-report') => new Request('http://localhost:3212/api/csp-report', { method: 'POST', headers: { 'content-type': type }, body })

beforeEach(() => {
  logged.length = 0
})

describe('CSP violation reports', () => {
  it('logs the directive, the blocked origin and the page path, without query strings', async () => {
    const res = await POST(req(JSON.stringify({ 'csp-report': {
      'document-uri': 'http://10.0.0.47:3212/live?group=abc', 'violated-directive': 'connect-src', 'effective-directive': 'connect-src',
      'blocked-uri': 'ws://10.0.0.9:3412/g/ws?token=SECRET.TOKEN', disposition: 'enforce',
    } })))
    expect(res.status).toBe(204)
    expect(logged).toEqual([{ event: 'csp_violation', directive: 'connect-src', blocked: 'ws://10.0.0.9:3412', page: '/live', disposition: 'enforce' }])
    expect(JSON.stringify(logged)).not.toContain('SECRET')
  })

  it('reads the newer report format too, and keeps keywords such as inline or eval', () => {
    expect(summariseReport([{ type: 'csp-violation', body: { documentURL: 'https://h/admin/users?x=1', effectiveDirective: 'script-src-elem', blockedURL: 'inline', disposition: 'report' } }]))
      .toEqual([{ directive: 'script-src-elem', blocked: 'inline', page: '/admin/users', disposition: 'report' }])
    expect(summariseReport({ 'csp-report': { 'effective-directive': 'script-src', 'blocked-uri': 'eval' } })).toEqual([{ directive: 'script-src', blocked: 'eval', page: null, disposition: null }])
  })

  it('ignores junk and anything too large', async () => {
    expect((await POST(req('not json'))).status).toBe(204)
    expect((await POST(req('x'.repeat(20_000)))).status).toBe(413)
    expect(summariseReport(null)).toEqual([])
    expect(summariseReport({ 'csp-report': { 'effective-directive': 'a'.repeat(500) } })).toEqual([])
    expect(logged).toEqual([])
  })
})
