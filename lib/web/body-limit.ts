// Final fix Y (final review B minor 2): request body limits per page. Next.js 16 knows one global Server Action limit
// (experimental.serverActions.bodySizeLimit) and one proxy buffer limit (experimental.proxyClientMaxBodySize), not one per action; both
// are set in next.config.ts to the largest legitimate upload (the import page's 5 MB CSV plus form overhead). The proxy refuses a
// larger body per page from its Content-Length before anything is read or a session is looked up (proxy.ts): small on the public
// pages, 1 MB on the signed-in pages, the full size only on the import page. A Server Action sent without a length (chunked) is refused
// outside the import page, so the global limit is the only ceiling there. GET and HEAD are not judged.

export const BODY_LIMITS = { public: 64 * 1024, standard: 1024 * 1024, upload: 6 * 1024 * 1024 } as const
/** Pages whose forms post files (lib/actions/admin/inventory.ts, import-locations.ts). */
export const UPLOAD_PAGES = new Set(['/admin/import'])
const PUBLIC = new Set(['/login', '/forgot-password', '/reset-password', '/auth/callback', '/api/csp-report', '/api/health', '/api/version'])

export type BodyRefusal = { status: 400 | 411 | 413; message: string }

export function bodyLimitRefusal(method: string, pathname: string, headers: Headers): BodyRefusal | null {
  if (method === 'GET' || method === 'HEAD' || method === 'OPTIONS') return null
  const upload = UPLOAD_PAGES.has(pathname)
  const limit = upload ? BODY_LIMITS.upload : PUBLIC.has(pathname) ? BODY_LIMITS.public : BODY_LIMITS.standard
  const raw = headers.get('content-length')
  if (raw === null) {
    // Final clean-up (Y-R7): a body sent without a length (Transfer-Encoding: chunked) would skip the per-page limit, so outside the
    // import page it is refused whatever it is (a Server Action, a route handler, a plain page). Browsers send a length for every
    // fetch, form and beacon body the app uses. The route handlers that read a body also cap while reading (readBodyCapped).
    if ((headers.has('next-action') || headers.has('transfer-encoding')) && !upload) return { status: 411, message: 'The request must say how large it is.' }
    return null
  }
  if (!/^\d{1,12}$/.test(raw.trim())) return { status: 400, message: 'The request is not valid.' }
  return Number(raw) > limit ? { status: 413, message: 'The request is too large.' } : null
}

/**
 * Final clean-up (Y-R7): a route handler's body read up to `max` bytes and no further (a declared length is not trusted: the stream is
 * counted while it is read and cancelled once it passes the limit). Null when it is larger; '' without a body. UTF-8.
 */
export async function readBodyCapped(request: Request, max: number): Promise<string | null> {
  if (!request.body) return ''
  const reader = request.body.getReader()
  const chunks: Uint8Array[] = []
  let size = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    size += value.byteLength
    if (size > max) {
      await reader.cancel().catch(() => {})
      return null
    }
    chunks.push(value)
  }
  return Buffer.concat(chunks).toString('utf8')
}
