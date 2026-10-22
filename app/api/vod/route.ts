import { getCurrentProfile } from '@/lib/auth/profile'
import { logger } from '@/lib/observability/logger'
import { streamRequestLimiter } from '@/lib/streams/request-limit'
import { canUseFastPlaybackInterim, MSG_FAST_NOT_FOR_YOU } from '@/lib/streams/speed'
import { MSG_VOD_BAD_REQUEST, parseVodQuery, serveVod } from '@/lib/streams/vod'
import { createAdminClient } from '@/lib/supabase/admin'
import { createClient } from '@/lib/supabase/server'

// Fast playback: GET /api/vod?camera=<id>&start=<yyyy-mm-ddThh:mm:ssZ>&minutes=<1..30> answers with video/mp4 made from the NVR's recording
// by ffmpeg (see lib/streams/vod.ts). It needs a signed-in person (the proxy sends everybody else to the sign-in page; this checks again)
// and changes nothing, so it is a GET, but it is counted like opening video. Only the query is read: no body, no cookies of its own.
// A failure before the video starts is JSON `{ "error": "..." }`; after that a failure just ends the video.

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs' // child processes

const HEADERS = { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Cross-Origin-Resource-Policy': 'same-origin' }
const error = (status: number, message: string, extra: Record<string, string> = {}) => Response.json({ error: message }, { status, headers: { ...HEADERS, ...extra } })

export async function GET(request: Request) {
  try {
    const profile = await getCurrentProfile()
    if (!profile) return error(401, 'Please sign in.')
    if (profile.must_reset_password) return error(403, 'Choose your own password first.')
    // Interim: administrators only, until the capability model replaces this one rule (it also covers ?probe=1). Nothing else is read or asked first.
    if (!canUseFastPlaybackInterim(profile.role)) return error(403, MSG_FAST_NOT_FOR_YOU)

    const parsed = parseVodQuery(new URL(request.url).searchParams)
    if (!parsed.ok) return error(parsed.error === 'Camera not found.' ? 404 : 400, parsed.error)

    return await serveVod({ rls: await createClient(), admin: createAdminClient(), limiter: streamRequestLimiter }, { id: profile.id }, parsed.query, request.signal)
  } catch (e) {
    // The kind of error only: its text can carry an address or a password.
    logger.error({ event: 'vod_route_failed', errorName: e instanceof Error ? e.name : typeof e })
    return error(500, 'Fast playback could not start. Please try again.')
  }
}

// A HEAD request must never start a conversion.
export function HEAD() {
  return error(405, MSG_VOD_BAD_REQUEST, { Allow: 'GET' })
}
