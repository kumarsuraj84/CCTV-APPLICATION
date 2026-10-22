import { logger } from '@/lib/observability/logger'
import { rateLimit } from '@/lib/rate-limit'
import { summariseReport } from '@/lib/web/csp-report'

// P3-1 brief item 2: browsers post what the Content Security Policy blocked (or, with CSP_REPORT_ONLY=1, would block) here
// (`report-uri /api/csp-report`, lib/web/csp.ts). Public (a report can come from the sign-in page), small and counted; only the
// directive, the blocked origin and the page path are logged.
// Review M-8: a declared length over 8 KB is refused before the body is read, the body is read up to 8 KB only, and the count is per
// client address (behind TRUSTED_PROXY_HOPS trusted proxies; otherwise one shared count), 30 a minute each, 600 in all.
export const dynamic = 'force-dynamic'

const MAX_BYTES = 8 * 1024
const PER_CLIENT = 30
const IN_ALL = 600

function clientOf(request: Request): string {
  const hops = Number(process.env.TRUSTED_PROXY_HOPS ?? 0)
  if (!Number.isInteger(hops) || hops < 1) return 'noip'
  const parts = (request.headers.get('x-forwarded-for') ?? '').split(',').map((s) => s.trim()).filter(Boolean)
  return parts.length >= hops ? parts[parts.length - hops].slice(0, 64) : 'noip'
}

async function readCapped(request: Request): Promise<string | null> {
  if (!request.body) return ''
  const reader = request.body.getReader()
  const chunks: Uint8Array[] = []
  let size = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    size += value.byteLength
    if (size > MAX_BYTES) {
      await reader.cancel().catch(() => {})
      return null
    }
    chunks.push(value)
  }
  return Buffer.concat(chunks).toString('utf8')
}

export async function POST(request: Request): Promise<Response> {
  const declared = Number(request.headers.get('content-length') ?? '0')
  if (Number.isFinite(declared) && declared > MAX_BYTES) return new Response(null, { status: 413 })
  const text = await readCapped(request)
  if (text === null) return new Response(null, { status: 413 })
  const client = clientOf(request)
  if ((await rateLimit(`csp-report:${client}`, PER_CLIENT, 60_000)).limited || (await rateLimit('csp-report:all', IN_ALL, 60_000)).limited) {
    return new Response(null, { status: 204 })
  }
  let json: unknown = null
  try {
    json = JSON.parse(text)
  } catch {
    return new Response(null, { status: 204 })
  }
  for (const r of summariseReport(json)) logger.warn({ event: 'csp_violation', ...r })
  return new Response(null, { status: 204 })
}
