import { processSingleton } from '@/lib/process-singleton'
import { createWindowLimiter } from '@/lib/streams/limiter'

// Counts of video requests per person, one per capability (P2-2 brief item 2: live, playback and export limits are separate; this
// replaces ruling R17's single shared count). In this process only (a shared store would be needed if the app ran as several copies;
// D-11), but one count for the whole process: route handlers, server actions and reloaded modules all see the same one
// (see lib/process-singleton.ts).

/** Requests per person per minute for opening video (ruling R17: 30; paging, layout changes and returning to the tab each ask once). */
export const STREAM_REQUESTS_PER_MINUTE = 30
export const MSG_TOO_MANY_REQUESTS = 'Too many video requests. Please wait a minute and try again.'

export type RequestLimiter = { allow(key: string): boolean }

/** cctv.live: opening live video and refreshing its tokens (sub and main). */
export const liveRequestLimiter: RequestLimiter = processSingleton('cctv.liveRequestLimiter', () => createWindowLimiter(STREAM_REQUESTS_PER_MINUTE, 60_000))

/** cctv.playback: opening a recording at 1x. */
export const playbackRequestLimiter: RequestLimiter = processSingleton('cctv.playbackRequestLimiter', () => createWindowLimiter(STREAM_REQUESTS_PER_MINUTE, 60_000))

/**
 * cctv.playback: looking at the calendar and the day's recordings. Each of these asks the NVR (a login and a search), and browsing a
 * month or several days quickly is normal, so this has its own, higher count (60 a minute).
 */
export const LOOKUPS_PER_MINUTE = 60
export const lookupRequestLimiter: RequestLimiter = processSingleton('cctv.lookupRequestLimiter', () => createWindowLimiter(LOOKUPS_PER_MINUTE, 60_000))

/** cctv.export: fast playback (/api/vod, its probe). The conversion limits of lib/streams/vod.ts apply on top. */
export const exportRequestLimiter: RequestLimiter = processSingleton('cctv.exportRequestLimiter', () => createWindowLimiter(STREAM_REQUESTS_PER_MINUTE, 60_000))
