import { auditAccess } from '@/lib/auth/access-audit'
import { holds } from '@/lib/auth/capabilities'
import { getCurrentProfile } from '@/lib/auth/profile'
import { MSG_ACCESS_CHECK_FAILED } from '@/lib/auth/resource'
import { logger } from '@/lib/observability/logger'
import { exportRequestLimiter, MSG_TOO_MANY_REQUESTS } from '@/lib/streams/request-limit'
import { FAST_PLAYBACK_CAPABILITY, MSG_FAST_NOT_FOR_YOU } from '@/lib/streams/speed'
import { MSG_VOD_BAD_REQUEST, parseVodQuery, serveVod } from '@/lib/streams/vod'
import { createAdminClient } from '@/lib/supabase/admin'
import { createClient } from '@/lib/supabase/server'
import { createMediaClient } from '@/lib/supabase/service-clients'

// Fast playback: GET /api/vod?camera=<id>&start=<yyyy-mm-ddThh:mm:ssZ>&minutes=<1..30> answers with video/mp4 made from the NVR's recording
// by ffmpeg (see lib/streams/vod.ts). It needs a signed-in person (the proxy sends everybody else to the sign-in page; this checks again)
// who holds cctv.export (D-6a, P2-2; the camera itself is checked by the service as the person), and changes nothing, so it is a GET,
// counted with the export count. Only the query is read: no body, no cookies of its own.
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
    // cctv.export somewhere, or nothing else is read or asked (it also covers ?probe=1). The refusal is recorded (counted first, so a
    // flood of refusals cannot flood the log).
    // Fast playback is a recording: cctv.export AND cctv.playback (fix M-3). An unreadable summary is the plain access-check failure (M-4).
    const failedCheck = profile.capabilities.failed
    if (failedCheck || !holds(profile.capabilities, FAST_PLAYBACK_CAPABILITY) || !holds(profile.capabilities, 'cctv.playback')) {
      if (!(await exportRequestLimiter.allow(profile.id))) return error(429, MSG_TOO_MANY_REQUESTS)
      await auditAccess(createAdminClient(), { orgId: profile.org_id, actorId: profile.id, action: 'cctv_export_denied', capability: FAST_PLAYBACK_CAPABILITY, detail: { reason: failedCheck ? 'access_check_failed' : 'no_capability' } })
      return failedCheck ? error(503, MSG_ACCESS_CHECK_FAILED) : error(403, MSG_FAST_NOT_FOR_YOU)
    }

    const parsed = parseVodQuery(new URL(request.url).searchParams)
    if (!parsed.ok) return error(parsed.error === 'Camera not found.' ? 404 : 400, parsed.error)

    // P2-6 (D-14): the video path's own database role (route, media session, NVR login for `vod`, its access audit rows).
    return await serveVod({ rls: await createClient(), admin: createMediaClient(), limiter: exportRequestLimiter }, { id: profile.id, orgId: profile.org_id }, parsed.query, request.signal)
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
