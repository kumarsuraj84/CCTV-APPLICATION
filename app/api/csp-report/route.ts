import { logger } from '@/lib/observability/logger'
import { rateLimit } from '@/lib/rate-limit'
import { summariseReport } from '@/lib/web/csp-report'

// P3-1 brief item 2: browsers post what the Content Security Policy blocked (or, with CSP_REPORT_ONLY=1, would block) here
// (`report-uri /api/csp-report`, lib/web/csp.ts). Public (a report can come from the sign-in page), small and counted: at most 8 KB,
// 120 reports a minute for the whole process; only the directive, the blocked origin and the page path are logged.
export const dynamic = 'force-dynamic'

const MAX_BYTES = 8 * 1024

export async function POST(request: Request): Promise<Response> {
  const text = await request.text()
  if (text.length > MAX_BYTES) return new Response(null, { status: 413 })
  if ((await rateLimit('csp-report', 120, 60_000)).limited) return new Response(null, { status: 204 })
  let json: unknown = null
  try {
    json = JSON.parse(text)
  } catch {
    return new Response(null, { status: 204 })
  }
  for (const r of summariseReport(json)) logger.warn({ event: 'csp_violation', ...r })
  return new Response(null, { status: 204 })
}
