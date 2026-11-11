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
    if (headers.has('next-action') && !upload) return { status: 411, message: 'The request must say how large it is.' }
    return null
  }
  if (!/^\d{1,12}$/.test(raw.trim())) return { status: 400, message: 'The request is not valid.' }
  return Number(raw) > limit ? { status: 413, message: 'The request is too large.' } : null
}
