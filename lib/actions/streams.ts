'use server'

import { requireProfile } from '@/lib/auth/profile'
import { logger } from '@/lib/observability/logger'
import { Go2rtcClient } from '@/lib/streams/go2rtc'
import { createWindowLimiter } from '@/lib/streams/limiter'
import { MSG_UNAVAILABLE, openStreams, type OpenedStream } from '@/lib/streams/open'
import { createAdminClient } from '@/lib/supabase/admin'
import { createClient } from '@/lib/supabase/server'

export type OpenStreamsState = { ok: true; streams: OpenedStream[] } | { ok: false; error: string }

/** Requests per person per minute (ruling R17: 30, up from 10, because paging, layout changes and returning to the tab each ask once). This process only; a shared store would be needed if the app ran as several copies. */
const STREAM_REQUESTS_PER_MINUTE = 30
const limiter = createWindowLimiter(STREAM_REQUESTS_PER_MINUTE, 60_000)
const TOO_MANY = 'Too many video requests. Please wait a minute and try again.'

async function run(cameraIds: string[], kind: 'sub' | 'main', route: string): Promise<OpenStreamsState> {
  const p = await requireProfile() // sends signed-out people to the sign-in page
  if (!limiter.allow(p.id)) return { ok: false, error: TOO_MANY }
  try {
    const go2rtc = new Go2rtcClient(process.env.GO2RTC_URL ?? 'http://127.0.0.1:1984')
    const res = await openStreams({ admin: createAdminClient(), rls: await createClient(), go2rtc }, { id: p.id, orgId: p.org_id }, Array.isArray(cameraIds) ? cameraIds : [], kind)
    return res.ok ? { ok: true, streams: res.streams } : { ok: false, error: res.error }
  } catch (error) {
    // The kind of error only, never its message: it can carry an address or a camera password.
    logger.error({ event: 'open_streams_action_failed', route, errorName: error instanceof Error ? error.name : typeof error })
    return { ok: false, error: MSG_UNAVAILABLE }
  }
}

/** Opens the cameras the caller may see (up to 36) and returns a signed token for each; the rest are left out without a word. */
export async function openStreamsAction(cameraIds: string[], kind: 'sub' | 'main'): Promise<OpenStreamsState> {
  return run(cameraIds, kind, 'openStreamsAction')
}

/** The same call, used by the wall every 8 minutes to get fresh tokens (they last 10 minutes). */
export async function refreshStreamTokensAction(cameraIds: string[], kind: 'sub' | 'main'): Promise<OpenStreamsState> {
  return run(cameraIds, kind, 'refreshStreamTokensAction')
}
