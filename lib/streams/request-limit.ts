import { processSingleton } from '@/lib/process-singleton'
import { sharedLimiter, type LimitName } from '@/lib/rate-limit-shared'

// Counts of video requests per person, one per capability (P2-2 brief item 2: live, playback and export limits are separate; this
// replaces ruling R17's single shared count). P2-6 (D-11, SO-7): the counts are SHARED by every app instance (the database's
// rate_limit_hit, lib/rate-limit-shared.ts), with a cheap in-process first filter; one object per process (route handlers, server actions
// and reloaded modules all use the same one, see lib/process-singleton.ts). When the database cannot be asked, opening video is still
// allowed within the in-process count (a read; sign-in and administration fail closed instead).

/** Requests per person per minute for opening video (ruling R17: 30; paging, layout changes and returning to the tab each ask once). */
export const STREAM_REQUESTS_PER_MINUTE = 30
export const MSG_TOO_MANY_REQUESTS = 'Too many video requests. Please wait a minute and try again.'

/** True (and counted) when the person may make one more request. A test may pass a synchronous one. */
export type RequestLimiter = { allow(key: string): boolean | Promise<boolean> }

const counted = (name: LimitName): RequestLimiter => ({ allow: async (key) => (await sharedLimiter().hit(name, key)).allowed })

/** cctv.live: opening live video and refreshing its tokens (sub and main). */
export const liveRequestLimiter: RequestLimiter = processSingleton('cctv.liveRequestLimiter', () => counted('live_open'))

/** cctv.playback: opening a recording at 1x. */
export const playbackRequestLimiter: RequestLimiter = processSingleton('cctv.playbackRequestLimiter', () => counted('playback_open'))

/**
 * cctv.playback: looking at the calendar and the day's recordings. Each of these asks the NVR (a login and a search), and browsing a
 * month or several days quickly is normal, so this has its own, higher count (60 a minute).
 */
export const LOOKUPS_PER_MINUTE = 60
export const lookupRequestLimiter: RequestLimiter = processSingleton('cctv.lookupRequestLimiter', () => counted('playback_lookup'))

/** P4-L2 review m-1: requests to the fast playback stream (/api/playback/stream), counted before anything is read or audited. */
export const fastStreamRequestLimiter: RequestLimiter = processSingleton('cctv.fastStreamRequestLimiter', () => counted('fast_stream'))

/** cctv.export: the saveable file (/api/vod, its probe). The conversion limits of lib/streams/vod.ts apply on top. */
export const exportRequestLimiter: RequestLimiter = processSingleton('cctv.exportRequestLimiter', () => counted('vod_open'))
