import { processSingleton } from '@/lib/process-singleton'
import { createWindowLimiter } from '@/lib/streams/limiter'

// One count of video requests per person, shared by everything that opens video or asks the NVR about recordings: the live wall,
// large pictures, and the playback screen. In this process only (a shared store would be needed if the app ran as several copies), but one count for the whole process: route handlers,
// server actions and reloaded modules all see the same one (see lib/process-singleton.ts).

/** Requests per person per minute (ruling R17: 30; paging, layout changes and returning to the tab each ask once). */
export const STREAM_REQUESTS_PER_MINUTE = 30
export const MSG_TOO_MANY_REQUESTS = 'Too many video requests. Please wait a minute and try again.'

export type RequestLimiter = { allow(key: string): boolean }

/** Opening live video and playback. */
export const streamRequestLimiter: RequestLimiter = processSingleton('cctv.streamRequestLimiter', () => createWindowLimiter(STREAM_REQUESTS_PER_MINUTE, 60_000))

/**
 * Looking at the calendar and the day's recordings. Each of these asks the NVR (a login and a search), and browsing a month or several
 * days quickly is normal, so this has its own, higher count (60 a minute) and does not use up the allowance for opening video.
 */
export const LOOKUPS_PER_MINUTE = 60
export const lookupRequestLimiter: RequestLimiter = processSingleton('cctv.lookupRequestLimiter', () => createWindowLimiter(LOOKUPS_PER_MINUTE, 60_000))
