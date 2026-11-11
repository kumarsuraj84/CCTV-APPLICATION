import { describe, expect, it } from 'vitest'
import { bodyLimitRefusal, BODY_LIMITS } from '@/lib/web/body-limit'

// Final fix Y (final review B minor 2): Next.js 16 has one global Server Action body limit (serverActions.bodySizeLimit) and one proxy
// buffer limit (proxyClientMaxBodySize), not one per action. So: the global limits are the largest legitimate upload (the 5 MB CSV of
// the import page, plus form overhead: 6 MB), and the proxy refuses a larger body by its Content-Length, per page, before anything is
// read or a session is looked up: 64 KB on the public pages, 1 MB elsewhere, 6 MB only on the import page.

const h = (o: Record<string, string>) => new Headers(o)
const action = (len: number | null) => h({ 'next-action': 'abc', ...(len === null ? {} : { 'content-length': String(len) }) })

describe('request body limits per page (B minor 2)', () => {
  it('the limits', () => {
    expect(BODY_LIMITS).toEqual({ public: 64 * 1024, standard: 1024 * 1024, upload: 6 * 1024 * 1024 })
  })

  it('public pages: 64 KB; signed-in pages: 1 MB; the import page: 6 MB', () => {
    expect(bodyLimitRefusal('POST', '/login', action(64 * 1024))).toBeNull()
    expect(bodyLimitRefusal('POST', '/login', action(64 * 1024 + 1))).toMatchObject({ status: 413 })
    expect(bodyLimitRefusal('POST', '/forgot-password', action(200_000))).toMatchObject({ status: 413 })
    expect(bodyLimitRefusal('POST', '/admin/users', action(1024 * 1024))).toBeNull()
    expect(bodyLimitRefusal('POST', '/admin/users', action(1024 * 1024 + 1))).toMatchObject({ status: 413 })
    expect(bodyLimitRefusal('POST', '/admin/import', action(6 * 1024 * 1024))).toBeNull()
    expect(bodyLimitRefusal('POST', '/admin/import', action(6 * 1024 * 1024 + 1))).toMatchObject({ status: 413 })
    expect(bodyLimitRefusal('POST', '/admin/import/x', action(2 * 1024 * 1024))).toMatchObject({ status: 413 }) // exactly the page
  })

  it('a Server Action without a length (a chunked body) is refused except on the import page; GET and HEAD are never judged', () => {
    expect(bodyLimitRefusal('POST', '/admin/users', action(null))).toMatchObject({ status: 411 })
    expect(bodyLimitRefusal('POST', '/login', action(null))).toMatchObject({ status: 411 })
    expect(bodyLimitRefusal('POST', '/admin/import', action(null))).toBeNull()
    expect(bodyLimitRefusal('GET', '/login', h({ 'content-length': '999999999' }))).toBeNull()
    expect(bodyLimitRefusal('HEAD', '/x', h({}))).toBeNull()
    expect(bodyLimitRefusal('POST', '/api/csp-report', h({ 'content-length': 'nonsense' }))).toMatchObject({ status: 400 })
  })
})
