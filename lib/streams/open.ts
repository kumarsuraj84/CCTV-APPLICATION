import type { Actor, AdminClient, Result } from '@/lib/admin/types'
import { mapLimit } from '@/lib/async/pool'
import { logger } from '@/lib/observability/logger'
import { getSecret } from '@/lib/secrets'
import type { Go2rtcClient } from '@/lib/streams/go2rtc'
import { buildRtspUrl, demoSource, isDemoStore } from '@/lib/streams/source'
import { signStreamToken, streamName, TOKEN_LIFETIME_SEC } from '@/lib/streams/token'

// Opens live streams for the cameras a person may watch live: registers each in go2rtc under its stream name and signs a token for it.
// The RTSP address (with the camera password) exists only inside this function, on its way to go2rtc. What comes back holds no
// password and no address, only the token the browser hands to the gateway.

export type OpenedStream = { cameraId: string; name: string; storeCode: string; channel: number; token: string; kind: 'sub' | 'main' }

/** The most streams one request may open (a 6 by 6 wall). */
export const MAX_STREAMS_PER_REQUEST = 36
export const MSG_NOT_SET_UP = 'Live video is not set up yet.'
export const MSG_UNAVAILABLE = 'The video server is not available.'
const MSG_NONE = 'Choose at least one camera.'
const MSG_TOO_MANY = `You can open at most ${MAX_STREAMS_PER_REQUEST} cameras at once.`
const MSG_FAILED = 'Could not open the video. Please try again.'
const REGISTER_PARALLEL = 6
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

type StoreRow = { code: string; nvr_ip: string; rtsp_port: number; nvr_username: string }
type CameraRow = { id: string; name: string; channel: number; store_id: string; stores: StoreRow | null }

export type OpenDeps = {
  admin: AdminClient
  /** The person's own signed-in client: it answers which cameras they may watch live. */
  rls: AdminClient
  go2rtc: Go2rtcClient
  env?: Record<string, string | undefined>
  /** Milliseconds since the epoch (default Date.now). */
  now?: () => number
}

export async function openStreams(
  deps: OpenDeps,
  actor: Pick<Actor, 'id' | 'orgId'>,
  cameraIds: string[],
  kind: 'sub' | 'main',
): Promise<Result<{ streams: OpenedStream[] }>> {
  const secret = getSecret('stream_token')
  if (!secret) return { ok: false, error: MSG_NOT_SET_UP }
  if (kind !== 'sub' && kind !== 'main') return { ok: false, error: MSG_FAILED }
  if (!Array.isArray(cameraIds) || cameraIds.length === 0) return { ok: false, error: MSG_NONE }
  if (cameraIds.length > MAX_STREAMS_PER_REQUEST) return { ok: false, error: MSG_TOO_MANY }

  // Anything that is not an id is dropped; so are repeats. One spelling (lower case) is used from here on.
  const wanted = [...new Set(cameraIds.filter((id): id is string => typeof id === 'string' && UUID.test(id)).map((id) => id.toLowerCase()))]
  if (wanted.length === 0) return { ok: false, error: MSG_NONE }

  // The person's own client decides which cameras they may watch live (cctv.live; P2-1, directive AC-2): a camera they may not watch
  // simply does not come back. Only for those, the NVR address and login are read with the service role (they are not readable by
  // signed-in people any more, AC-10), and only in the person's own organisation.
  const allowed = await deps.rls.rpc('cameras_with_capability', { p_cap: 'cctv.live', p_ids: wanted })
  if (allowed.error) {
    logger.error({ event: 'open_streams_check_failed', errorCode: allowed.error.code })
    return { ok: false, error: MSG_FAILED }
  }
  const mayWatch = (allowed.data as unknown as string[] | null) ?? []
  if (mayWatch.length === 0) return { ok: true, streams: [] }
  const found = await deps.admin
    .from('cameras')
    .select('id, name, channel, store_id, stores!inner(code, nvr_ip, rtsp_port, nvr_username, is_active)')
    .eq('org_id', actor.orgId)
    .in('id', mayWatch)
    .eq('is_active', true)
    .eq('stores.is_active', true)
  if (found.error) {
    logger.error({ event: 'open_streams_read_failed', errorCode: found.error.code })
    return { ok: false, error: MSG_FAILED }
  }
  const byId = new Map((found.data as unknown as CameraRow[]).filter((c) => c.stores !== null).map((c) => [c.id, c]))
  const cameras = wanted.map((id) => byId.get(id)).filter((c): c is CameraRow => c !== undefined)
  if (cameras.length === 0) return { ok: true, streams: [] }

  const env = deps.env ?? process.env
  // One password read per store, and only for stores that need one (a demo store has no real camera behind it).
  const passwords = new Map<string, string | null>()
  const storeIds = [...new Set(cameras.map((c) => c.store_id))]
  await mapLimit(storeIds, 4, async (storeId) => {
    const store = cameras.find((c) => c.store_id === storeId)!.stores!
    if (isDemoStore({ code: store.code, nvr_ip: store.nvr_ip }, env)) return
    const { data, error } = await deps.admin.rpc('nvr_read_credential', { p_store: storeId })
    if (error) logger.error({ event: 'open_streams_credential_failed', store: store.code, errorCode: error.code })
    passwords.set(storeId, !error && typeof data === 'string' && data !== '' ? data : null)
  })

  const now = deps.now ?? Date.now
  const exp = Math.floor(now() / 1000) + TOKEN_LIFETIME_SEC
  let failed = 0
  const opened = await mapLimit(cameras, REGISTER_PARALLEL, async (c): Promise<OpenedStream | null> => {
    const store = c.stores!
    try {
      let src: string
      const demo = isDemoStore({ code: store.code, nvr_ip: store.nvr_ip }, env)
      if (demo) src = demoSource(c.channel, c.id)
      else {
        const password = passwords.get(c.store_id)
        if (!password) return null // no saved NVR password: this camera cannot be opened (and the others still can)
        src = buildRtspUrl({ host: store.nvr_ip, port: store.rtsp_port, username: store.nvr_username, password, channel: c.channel, kind })
      }
      const name = streamName({ c: c.id, k: kind })
      await deps.go2rtc.register(name, src, { keepExisting: demo })
      const token = signStreamToken({ u: actor.id, c: c.id, k: kind, exp }, secret)
      return { cameraId: c.id, name: c.name, storeCode: store.code, channel: c.channel, token, kind }
    } catch {
      failed++
      logger.error({ event: 'open_stream_failed', store: store.code, channel: c.channel, kind }) // no address, no error text: they can carry a password
      return null
    }
  })
  // Streams nobody has watched for a long time are removed from go2rtc (at most once a minute; never waits, never fails the request).
  void deps.go2rtc.prune({ now: now() }).catch(() => {})
  const streams = opened.filter((s): s is OpenedStream => s !== null)
  if (streams.length === 0 && failed > 0) return { ok: false, error: MSG_UNAVAILABLE }
  return { ok: true, streams }
}
