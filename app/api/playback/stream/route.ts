import { holds } from '@/lib/auth/capabilities'
import { MSG_CODE_FIRST } from '@/lib/auth/mfa'
import { getCurrentProfile, mfaGateOf } from '@/lib/auth/profile'
import { MSG_ACCESS_CHECK_FAILED } from '@/lib/auth/resource'
import { logger } from '@/lib/observability/logger'
import { serveFastStream } from '@/lib/streams/fast'
import { fastStreamRequestLimiter, MSG_TOO_MANY_REQUESTS } from '@/lib/streams/request-limit'
import { FAST_PLAYBACK_CAPABILITY, FAST_TOKEN_HEADER, MSG_FAST_NOT_FOR_YOU } from '@/lib/streams/speed'
import { createClient } from '@/lib/supabase/server'
import { createMediaClient } from '@/lib/supabase/service-clients'

// P4-L2 (decision D-L1): fast playback 2x-16x reaches a browser ONLY here, as a stream the Playback screen reads with fetch() and plays
// through Media Source Extensions; never as a file. GET /api/playback/stream with the fast-playback token in the x-playback-token header.
//   - A signed-in, active person who has finished signing in (the same gate as every page) and holds cctv.playback somewhere; the camera,
//     the person the token was made for and the token's media session are checked by the service (lib/streams/fast.ts).
//   - Not a file: no Content-Disposition, `application/vnd.ckdrishti.stream`, no-store. What a person could open or save is refused before
//     anything is read: a typed address, a link or a download (Sec-Fetch-Mode navigate / Sec-Fetch-Dest document), a <video>/<audio>
//     source, a frame, an embed, and any request without the header (a browser cannot add a header to those). A token in the address is
//     refused too (addresses end up in history and server logs).
//   - Viewing, not a download: no fresh sign-in (tests/unit/fresh-auth-guard.test.ts allow-list); saveable files stay on /api/vod
//     (cctv.export, fresh sign-in).

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs' // child processes (the remux adapter)

const HEADERS = { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Cross-Origin-Resource-Policy': 'same-origin' }
const error = (status: number, message: string, extra: Record<string, string> = {}) => Response.json({ error: message }, { status, headers: { ...HEADERS, ...extra } })
const MSG_STREAM_ONLY = 'This address is only for the Playback screen.'
const NOT_FOR_FILES = new Set(['document', 'iframe', 'frame', 'embed', 'object', 'video', 'audio', 'track', 'image', 'script', 'style', 'worker', 'sharedworker', 'serviceworker'])

/** True for a script fetch with the header; false for anything a person could open, link to, embed or save. */
function scriptFetchOnly(request: Request): boolean {
  const mode = request.headers.get('sec-fetch-mode')
  const dest = request.headers.get('sec-fetch-dest')
  if (mode === 'navigate' || mode === 'nested-navigate') return false
  if (dest !== null && NOT_FOR_FILES.has(dest)) return false
  const token = request.headers.get(FAST_TOKEN_HEADER)
  return typeof token === 'string' && token.length > 0 && token.length <= 1024
}

export async function GET(request: Request) {
  try {
    const profile = await getCurrentProfile()
    if (!profile) return error(401, 'Please sign in.')
    if (profile.must_reset_password) return error(403, 'Choose your own password first.')
    if (mfaGateOf(profile) !== 'ok') return error(403, MSG_CODE_FIRST)
    if (profile.capabilities.failed) return error(503, MSG_ACCESS_CHECK_FAILED)
    if (!holds(profile.capabilities, FAST_PLAYBACK_CAPABILITY)) return error(403, MSG_FAST_NOT_FOR_YOU)
    // Review m-1: counted before anything is read or a refusal is audited (a loop of junk tokens cannot flood the audit log).
    if (!(await fastStreamRequestLimiter.allow(profile.id))) return error(429, MSG_TOO_MANY_REQUESTS)

    const url = new URL(request.url)
    if (url.search !== '' || !scriptFetchOnly(request)) return error(400, MSG_STREAM_ONLY)

    // P2-6 (D-14): the video path's own database role (camera route, media session, NVR login for `playback`, its access audit rows).
    return await serveFastStream({ rls: await createClient(), admin: createMediaClient() }, { id: profile.id, orgId: profile.org_id }, request.headers.get(FAST_TOKEN_HEADER)!, request.signal)
  } catch (e) {
    // The kind of error only: its text can carry an address or a password.
    logger.error({ event: 'fast_stream_route_failed', errorName: e instanceof Error ? e.name : typeof e })
    return error(500, 'Fast playback could not start. Please try again.')
  }
}

// A HEAD request must never start anything.
export function HEAD() {
  return error(405, 'Method not allowed', { Allow: 'GET' })
}
