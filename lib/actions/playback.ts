'use server'

import { auditAccess } from '@/lib/auth/access-audit'
import { holds } from '@/lib/auth/capabilities'
import { requireProfile } from '@/lib/auth/profile'
import { MSG_ACCESS_CHECK_FAILED } from '@/lib/auth/resource'
import { logger } from '@/lib/observability/logger'
import { Go2rtcClient } from '@/lib/streams/go2rtc'
import { MSG_UNAVAILABLE } from '@/lib/streams/open'
import { MSG_BAD_SPEED, openFastPlayback } from '@/lib/streams/fast'
import { listDaySegments, listOldestRecording, listRecordedDays, openPlayback, parsePlaybackOffset } from '@/lib/streams/playback'
import { lookupRequestLimiter, playbackRequestLimiter } from '@/lib/streams/request-limit'
import { isFastSpeed } from '@/lib/streams/speed'
import { parseDay, parseStartIso } from '@/lib/streams/timeline'
import { createAdminClient } from '@/lib/supabase/admin'
import { createClient } from '@/lib/supabase/server'
import { createMediaClient } from '@/lib/supabase/service-clients'

// Playback actions (cctv.playback: calendar, day search and 1x playback; P2-2). Each one checks who is asking first, checks its input,
// and answers with a plain message instead of throwing: the browser never sees an error text from the NVR, go2rtc or the database.
// A person without cctv.playback, and a camera they may not play back, both get "Camera not found." (the same as a camera that does not
// exist), and nothing is asked. Times are "shown times" (see lib/streams/playback.ts).

export type RecordedDaysState = { ok: true; days: number[] } | { ok: false; error: string }
export type DaySegmentsState = { ok: true; segments: { start: string; end: string }[]; truncated: boolean; skipped: number } | { ok: false; error: string }
export type OpenPlaybackState = { ok: true; token: string; name: string } | { ok: false; error: string }
export type OpenFastPlaybackState = { ok: true; token: string; minutes: number } | { ok: false; error: string }
export type OldestRecordingState = { ok: true; oldest: string | null } | { ok: false; error: string }

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

/**
 * The person; or the refusal: the plain access-check failure when the summary could not be read (fix M-4), "Camera not found." when
 * they hold cctv.playback nowhere.
 */
async function playbackPerson(): Promise<{ ok: true; p: Awaited<ReturnType<typeof requireProfile>> } | { ok: false; error: string }> {
  const p = await requireProfile() // sends signed-out people to the sign-in page
  if (p.capabilities.failed) return { ok: false, error: MSG_ACCESS_CHECK_FAILED }
  return holds(p.capabilities, 'cctv.playback') ? { ok: true, p } : { ok: false, error: NOT_FOUND }
}

/** The days of a month that the NVR calendar marks (a hint: any day may be opened). */
export async function listRecordedDaysAction(cameraId: string, year: number, month: number): Promise<RecordedDaysState> {
  const who = await playbackPerson()
  if (!who.ok) return who
  const { p } = who
  if (typeof cameraId !== 'string' || !UUID.test(cameraId)) return { ok: false, error: NOT_FOUND }
  if (!Number.isInteger(year) || year < 2000 || year > 2100 || !Number.isInteger(month) || month < 1 || month > 12) return { ok: false, error: BAD_REQUEST }
  try {
    // P2-6 (D-14): the video path's own database role reads the route and the NVR login; the audit row is the web app's.
    const res = await listRecordedDays({ rls: await createClient(), admin: createMediaClient(), limiter: lookupRequestLimiter }, { id: p.id, orgId: p.org_id }, cameraId, year, month, offset())
    if (res.ok) await auditAccess(createAdminClient(), { orgId: p.org_id, actorId: p.id, action: 'cctv_playback_searched', capability: 'cctv.playback', cameraIds: [cameraId.toLowerCase()], detail: { what: 'calendar', month: `${year}-${String(month).padStart(2, '0')}` } })
    return res
  } catch (error) {
    return failed('playback_days_action_failed', 'listRecordedDaysAction', error, FAILED)
  }
}

/** The recordings of one day (`yyyy-mm-dd`), as shown times. */
export async function listDaySegmentsAction(cameraId: string, day: string): Promise<DaySegmentsState> {
  const who = await playbackPerson()
  if (!who.ok) return who
  const { p } = who
  if (typeof cameraId !== 'string' || !UUID.test(cameraId)) return { ok: false, error: NOT_FOUND }
  if (parseDay(day) === null) return { ok: false, error: BAD_REQUEST }
  try {
    const res = await listDaySegments({ rls: await createClient(), admin: createMediaClient(), limiter: lookupRequestLimiter }, { id: p.id, orgId: p.org_id }, cameraId, day, offset())
    if (res.ok) await auditAccess(createAdminClient(), { orgId: p.org_id, actorId: p.id, action: 'cctv_playback_searched', capability: 'cctv.playback', cameraIds: [cameraId.toLowerCase()], detail: { what: 'day', day } })
    return res
  } catch (error) {
    return failed('playback_segments_action_failed', 'listDaySegmentsAction', error, FAILED)
  }
}

/** Starts playback from `startIso` (`yyyy-mm-ddThh:mm[:ss]Z`, a shown time) for `minutes` (1 to 60); returns a token for the video gateway. */
export async function openPlaybackAction(cameraId: string, startIso: string, minutes: number): Promise<OpenPlaybackState> {
  const who = await playbackPerson()
  if (!who.ok) return who
  const { p } = who
  if (typeof cameraId !== 'string' || !UUID.test(cameraId)) return { ok: false, error: NOT_FOUND }
  const start = typeof startIso === 'string' ? parseStartIso(startIso) : null
  if (!start) return { ok: false, error: 'Choose a start time.' }
  if (!Number.isInteger(minutes)) return { ok: false, error: 'Choose how long to play.' }
  try {
    const go2rtc = new Go2rtcClient(process.env.GO2RTC_URL ?? 'http://127.0.0.1:1984')
    // Opening a recording has its own count (playback), separate from the live wall and from fast playback.
    const res = await openPlayback({ rls: await createClient(), admin: createMediaClient(), go2rtc, limiter: playbackRequestLimiter }, { id: p.id, orgId: p.org_id }, cameraId, start, minutes, offset())
    if (res.ok) await auditAccess(createAdminClient(), { orgId: p.org_id, actorId: p.id, action: 'cctv_playback_opened', capability: 'cctv.playback', cameraIds: [cameraId.toLowerCase()], detail: { minutes } })
    return res
  } catch (error) {
    return failed('open_playback_action_failed', 'openPlaybackAction', error, MSG_UNAVAILABLE)
  }
}

/**
 * P4-L2 (decision D-L1): fast playback 2x-16x from `startIso` for `minutes` (1 to 30). cctv.playback for the camera is enough (export is
 * not needed); the answer is a short-lived token for the stream path (/api/playback/stream), never a file address. Counted with the
 * playback openings and audited like a 1x opening, with the speed.
 */
export async function openFastPlaybackAction(cameraId: string, startIso: string, minutes: number, speed: number): Promise<OpenFastPlaybackState> {
  const who = await playbackPerson()
  if (!who.ok) return who
  const { p } = who
  if (typeof cameraId !== 'string' || !UUID.test(cameraId)) return { ok: false, error: NOT_FOUND }
  const start = typeof startIso === 'string' ? parseStartIso(startIso) : null
  if (!start) return { ok: false, error: 'Choose a start time.' }
  if (!Number.isInteger(minutes)) return { ok: false, error: 'Choose how long to play.' }
  if (!isFastSpeed(speed)) return { ok: false, error: MSG_BAD_SPEED }
  try {
    const res = await openFastPlayback({ rls: await createClient(), admin: createMediaClient(), limiter: playbackRequestLimiter, offsetMin: offset() }, { id: p.id, orgId: p.org_id }, cameraId, start, minutes, speed)
    if (res.ok) await auditAccess(createAdminClient(), { orgId: p.org_id, actorId: p.id, action: 'cctv_playback_opened', capability: 'cctv.playback', cameraIds: [cameraId.toLowerCase()], detail: { minutes, speed } })
    return res
  } catch (error) {
    return failed('open_fast_playback_action_failed', 'openFastPlaybackAction', error, MSG_UNAVAILABLE)
  }
}

/** P4-L2 (LG-9): when the oldest recording of this camera starts (a shown time), or null when the NVR has none in the last 400 days. */
export async function oldestRecordingAction(cameraId: string): Promise<OldestRecordingState> {
  const who = await playbackPerson()
  if (!who.ok) return who
  const { p } = who
  if (typeof cameraId !== 'string' || !UUID.test(cameraId)) return { ok: false, error: NOT_FOUND }
  try {
    const res = await listOldestRecording({ rls: await createClient(), admin: createMediaClient(), limiter: lookupRequestLimiter }, { id: p.id, orgId: p.org_id }, cameraId, offset())
    if (res.ok) await auditAccess(createAdminClient(), { orgId: p.org_id, actorId: p.id, action: 'cctv_playback_searched', capability: 'cctv.playback', cameraIds: [cameraId.toLowerCase()], detail: { what: 'oldest' } })
    return res
  } catch (error) {
    return failed('playback_oldest_action_failed', 'oldestRecordingAction', error, FAILED)
  }
}
