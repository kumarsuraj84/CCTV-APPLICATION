import { auditAccess } from '@/lib/auth/access-audit'
import { holds } from '@/lib/auth/capabilities'
import { requireFreshFor } from '@/lib/auth/fresh'
import { MSG_CODE_FIRST } from '@/lib/auth/mfa'
import { getCurrentProfile, mfaGateOf } from '@/lib/auth/profile'
import { MSG_ACCESS_CHECK_FAILED } from '@/lib/auth/resource'
import { logger } from '@/lib/observability/logger'
import { exportRequestLimiter, MSG_TOO_MANY_REQUESTS } from '@/lib/streams/request-limit'
import { EXPORT_CAPABILITY, MSG_EXPORT_NOT_FOR_YOU } from '@/lib/streams/speed'
import { MSG_VOD_BAD_REQUEST, parseVodQuery, serveVod } from '@/lib/streams/vod'
import { createAdminClient } from '@/lib/supabase/admin'
import { createClient } from '@/lib/supabase/server'
import { createMediaClient } from '@/lib/supabase/service-clients'

// A SAVEABLE recording file: GET /api/vod?camera=<id>&start=<yyyy-mm-ddThh:mm:ssZ>&minutes=<1..30> answers with video/mp4 made from the
// NVR's recording by the remux adapter (see lib/streams/vod.ts). Decision D-L1 (P4-L2): this is the EXPORT path only — fast playback on the
// Playback screen moved to the stream path (/api/playback/stream, cctv.playback); this route needs cctv.export AND cctv.playback (ruling
// M-3), and only administrators may hold cctv.export (ruling E-1), so a viewer with playback alone can never download a file here. It needs
// a signed-in person (the proxy sends everybody else to the sign-in page; this checks again), a fresh sign-in (D-10 "exports"), and
// changes nothing, so it is a GET, counted with the export count. Only the query is read: no body, no cookies of its own.
// A failure before the video starts is JSON `{ "error": "..." }`; after that a failure just ends the video.

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs' // child processes

const HEADERS = { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Cross-Origin-Resource-Policy': 'same-origin' }
const error = (status: number, message: string, extra: Record<string, string> = {}) => Response.json({ error: message }, { status, headers: { ...HEADERS, ...extra } })

export async function GET(request: Request) {
  try {
    // Final fix Y (final review B minor 4): only from the app's own pages (or a typed address); a link on another site would otherwise
    // start an export (and its audit row) in the signed-in person's name, since SameSite=Lax cookies go with a top-level navigation.
    const site = request.headers.get('sec-fetch-site')
    if (site !== null && site !== 'same-origin' && site !== 'none') return error(403, 'Open the download from Drishti itself.')
    const profile = await getCurrentProfile()
    if (!profile) return error(401, 'Please sign in.')
    if (profile.must_reset_password) return error(403, 'Choose your own password first.')
    // P3-1 review M-1: the same sign-in gate as every page: a person with an authenticator app finishes the code first.
    if (mfaGateOf(profile) !== 'ok') return error(403, MSG_CODE_FIRST)
    // cctv.export somewhere, or nothing else is read or asked (it also covers ?probe=1). The refusal is recorded (counted first, so a
    // flood of refusals cannot flood the log).
    // A recording file: cctv.export AND cctv.playback (fix M-3). An unreadable summary is the plain access-check failure (M-4).
    const failedCheck = profile.capabilities.failed
    if (failedCheck || !holds(profile.capabilities, EXPORT_CAPABILITY) || !holds(profile.capabilities, 'cctv.playback')) {
      if (!(await exportRequestLimiter.allow(profile.id))) return error(429, MSG_TOO_MANY_REQUESTS)
      await auditAccess(createAdminClient(), { orgId: profile.org_id, actorId: profile.id, action: 'cctv_export_denied', capability: EXPORT_CAPABILITY, detail: { reason: failedCheck ? 'access_check_failed' : 'no_capability' } })
      return failedCheck ? error(503, MSG_ACCESS_CHECK_FAILED) : error(403, MSG_EXPORT_NOT_FOR_YOU)
    }

    // P3-1 review I-3 (D-10 "exports"): a downloadable recording, so it goes through the fresh-sign-in guard too.
    const stale = requireFreshFor(profile)
    if (stale) return error(403, stale)

    const parsed = parseVodQuery(new URL(request.url).searchParams)
    if (!parsed.ok) return error(parsed.error === 'Camera not found.' ? 404 : 400, parsed.error)

    // P2-6 (D-14): the video path's own database role (route, media session, NVR login for `vod`, its access audit rows).
    return await serveVod({ rls: await createClient(), admin: createMediaClient(), limiter: exportRequestLimiter }, { id: profile.id, orgId: profile.org_id, aal2: profile.session?.aal2 === true }, parsed.query, request.signal)
  } catch (e) {
    // The kind of error only: its text can carry an address or a password.
    logger.error({ event: 'vod_route_failed', errorName: e instanceof Error ? e.name : typeof e })
    return error(500, 'The recording could not be prepared. Please try again.') // review m-2: the export path, not fast playback
  }
}

// A HEAD request must never start a conversion.
export function HEAD() {
  return error(405, MSG_VOD_BAD_REQUEST, { Allow: 'GET' })
}
