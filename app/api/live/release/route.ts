import { getCurrentProfile } from '@/lib/auth/profile'
import { logger } from '@/lib/observability/logger'
import { releaseStreams } from '@/lib/streams/open'
import { createMediaClient } from '@/lib/supabase/service-clients'

// P4-L1 fix round 2 (re-review N-1, N-6): what a Live page sends when it is left — pagehide, the tab hidden, a route change (fetch with
// keepalive; best effort). Body: { tokens: string[] }, the live tokens the page holds. The unused ones (the one-minute renewal's) stop
// counting against the person's stream cap at once instead of for up to 90 s (lib/streams/open.ts releaseStreams): only tokens this
// server signed for this person and for live video count, so a release reaches neither another window's or person's token nor a token
// handed out after the page was left. An open socket is never ended here and nothing is opened or read: it only takes the caller's
// own unused tokens away, so it needs no fresh sign-in (tests/unit/fresh-auth-guard.test.ts allow-list).
//   - Signed-in people only; same-origin JSON only (Sec-Fetch-Site, or Origin when a browser sends no Sec-Fetch-Site); 16 KB at most.

export const dynamic = 'force-dynamic'

const MAX_BODY = 16_384
const HEADERS = { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' }
const answer = (status: number, message?: string) =>
  message ? Response.json({ error: message }, { status, headers: HEADERS }) : new Response(null, { status, headers: HEADERS })

function sameOrigin(request: Request): boolean {
  const site = request.headers.get('sec-fetch-site')
  if (site !== null) return site === 'same-origin'
  const origin = request.headers.get('origin')
  if (origin === null) return true // not a browser's cross-site request (those always carry one of the two)
  try {
    return new URL(origin).host === (request.headers.get('host') ?? new URL(request.url).host)
  } catch {
    return false
  }
}

export async function POST(request: Request) {
  try {
    const profile = await getCurrentProfile()
    if (!profile) return answer(401, 'Please sign in.')
    if (!sameOrigin(request)) return answer(403, 'Not allowed.')
    if (!(request.headers.get('content-type') ?? '').toLowerCase().startsWith('application/json')) return answer(415, 'JSON only.')
    const text = await request.text()
    if (text.length > MAX_BODY) return answer(413, 'Too large.')
    let body: unknown
    try {
      body = JSON.parse(text)
    } catch {
      return answer(400, 'Not understood.')
    }
    const tokens = body && typeof body === 'object' ? (body as { tokens?: unknown }).tokens : undefined
    if (!Array.isArray(tokens)) return answer(400, 'Not understood.')
    const res = await releaseStreams({ admin: createMediaClient() }, { id: profile.id, orgId: profile.org_id }, tokens)
    return res.ok ? answer(204) : answer(503, res.error)
  } catch (e) {
    logger.error({ event: 'live_release_route_failed', errorName: e instanceof Error ? e.name : typeof e })
    return answer(503, 'Could not release the video.')
  }
}
