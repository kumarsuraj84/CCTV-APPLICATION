'use server'

import { auditAccess } from '@/lib/auth/access-audit'
import { holds } from '@/lib/auth/capabilities'
import { requireProfile } from '@/lib/auth/profile'
import { logger } from '@/lib/observability/logger'
import { Go2rtcClient } from '@/lib/streams/go2rtc'
import { MSG_UNAVAILABLE } from '@/lib/streams/open'
import { listDaySegments, listRecordedDays, openPlayback, parsePlaybackOffset } from '@/lib/streams/playback'
import { lookupRequestLimiter, playbackRequestLimiter } from '@/lib/streams/request-limit'
import { parseDay, parseStartIso } from '@/lib/streams/timeline'
import { createAdminClient } from '@/lib/supabase/admin'
import { createClient } from '@/lib/supabase/server'

// Playback actions (cctv.playback: calendar, day search and 1x playback; P2-2). Each one checks who is asking first, checks its input,
// and answers with a plain message instead of throwing: the browser never sees an error text from the NVR, go2rtc or the database.
// A person without cctv.playback, and a camera they may not play back, both get "Camera not found." (the same as a camera that does not
// exist), and nothing is asked. Times are "shown times" (see lib/streams/playback.ts).

export type RecordedDaysState = { ok: true; days: number[] } | { ok: false; error: string }
export type DaySegmentsState = { ok: true; segments: { start: string; end: string }[]; truncated: boolean; skipped: number } | { ok: false; error: string }
export type OpenPlaybackState = { ok: true; token: string; name: string } | { ok: false; error: string }

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const NOT_FOUND = 'Camera not found.'
const BAD_REQUEST = 'That request is not valid.'
const FAILED = 'Could not read the recordings. Please try again.'

const offset = () => parsePlaybackOffset(process.env.PLAYBACK_OFFSET_MIN)

function failed(event: string, route: string, error: unknown, message: string) {
  // The kind of error only, never its message: it can carry an address or a camera password.
  logger.error({ event, route, errorName: error instanceof Error ? error.name : typeof error })
  return { ok: false as const, error: message }
}

/** The person, or null when they hold cctv.playback nowhere (then the answer is "Camera not found."). */
async function playbackPerson() {
  const p = await requireProfile() // sends signed-out people to the sign-in page
  return holds(p.capabilities, 'cctv.playback') ? p : null
}

/** The days of a month that the NVR calendar marks (a hint: any day may be opened). */
export async function listRecordedDaysAction(cameraId: string, year: number, month: number): Promise<RecordedDaysState> {
  const p = await playbackPerson()
  if (!p || typeof cameraId !== 'string' || !UUID.test(cameraId)) return { ok: false, error: NOT_FOUND }
  if (!Number.isInteger(year) || year < 2000 || year > 2100 || !Number.isInteger(month) || month < 1 || month > 12) return { ok: false, error: BAD_REQUEST }
  try {
    const admin = createAdminClient()
    const res = await listRecordedDays({ rls: await createClient(), admin, limiter: lookupRequestLimiter }, { id: p.id, orgId: p.org_id }, cameraId, year, month, offset())
    if (res.ok) await auditAccess(admin, { orgId: p.org_id, actorId: p.id, action: 'cctv_playback_searched', capability: 'cctv.playback', cameraIds: [cameraId.toLowerCase()], detail: { what: 'calendar', month: `${year}-${String(month).padStart(2, '0')}` } })
    return res
  } catch (error) {
    return failed('playback_days_action_failed', 'listRecordedDaysAction', error, FAILED)
  }
}

/** The recordings of one day (`yyyy-mm-dd`), as shown times. */
export async function listDaySegmentsAction(cameraId: string, day: string): Promise<DaySegmentsState> {
  const p = await playbackPerson()
  if (!p || typeof cameraId !== 'string' || !UUID.test(cameraId)) return { ok: false, error: NOT_FOUND }
  if (parseDay(day) === null) return { ok: false, error: BAD_REQUEST }
  try {
    const admin = createAdminClient()
    const res = await listDaySegments({ rls: await createClient(), admin, limiter: lookupRequestLimiter }, { id: p.id, orgId: p.org_id }, cameraId, day, offset())
    if (res.ok) await auditAccess(admin, { orgId: p.org_id, actorId: p.id, action: 'cctv_playback_searched', capability: 'cctv.playback', cameraIds: [cameraId.toLowerCase()], detail: { what: 'day', day } })
    return res
  } catch (error) {
    return failed('playback_segments_action_failed', 'listDaySegmentsAction', error, FAILED)
  }
}

/** Starts playback from `startIso` (`yyyy-mm-ddThh:mm[:ss]Z`, a shown time) for `minutes` (1 to 60); returns a token for the video gateway. */
export async function openPlaybackAction(cameraId: string, startIso: string, minutes: number): Promise<OpenPlaybackState> {
  const p = await playbackPerson()
  if (!p || typeof cameraId !== 'string' || !UUID.test(cameraId)) return { ok: false, error: NOT_FOUND }
  const start = typeof startIso === 'string' ? parseStartIso(startIso) : null
  if (!start) return { ok: false, error: 'Choose a start time.' }
  if (!Number.isInteger(minutes)) return { ok: false, error: 'Choose how long to play.' }
  try {
    const go2rtc = new Go2rtcClient(process.env.GO2RTC_URL ?? 'http://127.0.0.1:1984')
    const admin = createAdminClient()
    // Opening a recording has its own count (playback), separate from the live wall and from fast playback.
    const res = await openPlayback({ rls: await createClient(), admin, go2rtc, limiter: playbackRequestLimiter }, { id: p.id, orgId: p.org_id }, cameraId, start, minutes, offset())
    if (res.ok) await auditAccess(admin, { orgId: p.org_id, actorId: p.id, action: 'cctv_playback_opened', capability: 'cctv.playback', cameraIds: [cameraId.toLowerCase()], detail: { minutes } })
    return res
  } catch (error) {
    return failed('open_playback_action_failed', 'openPlaybackAction', error, MSG_UNAVAILABLE)
  }
}
