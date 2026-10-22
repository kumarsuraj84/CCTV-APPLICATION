import type { Actor, AdminClient, Result } from '@/lib/admin/types'
import { mapLimit } from '@/lib/async/pool'
import { camerasFor } from '@/lib/auth/resource'
import { MSG_MONITORING_OFF, MSG_NOT_MAPPED, readRecorderPassword, resolveCameraRoutes, type RouteAnswer } from '@/lib/inventory/recorders'
import { logger } from '@/lib/observability/logger'
import { getSecret } from '@/lib/secrets'
import type { Go2rtcClient } from '@/lib/streams/go2rtc'
import { createMediaSessions } from '@/lib/streams/registry'
import { buildRtspUrl, demoSource, isDemoRecorder } from '@/lib/streams/source'
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
  const allowed = await camerasFor(deps.rls, 'cctv.live', wanted)
  if (!allowed.ok) return { ok: false, error: MSG_FAILED }
  const mayWatch = allowed.ids
  if (mayWatch.length === 0) return { ok: true, streams: [] }
  // P2-5b: each camera is reached through the recorder of its ACTIVE channel mapping — that NVR's address, video port, login and
  // password, and the channel of the mapping. Owner addition: nothing is opened towards an NVR whose monitoring is switched off (no
  // credential read, no go2rtc call); a camera without a mapping cannot be opened at all.
  let answers
  try {
    answers = await resolveCameraRoutes(deps.admin, actor.orgId, mayWatch)
  } catch {
    logger.error({ event: 'open_streams_read_failed' })
    return { ok: false, error: MSG_FAILED }
  }
  const listed = wanted.map((id) => answers.get(id)).filter((a): a is RouteAnswer => a !== undefined)
  if (listed.length === 0) return { ok: true, streams: [] }
  const routes = listed.flatMap((a) => (a.kind === 'ok' ? [a.route] : []))
  if (routes.length === 0) return { ok: false, error: listed.some((a) => a.kind === 'off') ? MSG_MONITORING_OFF : MSG_NOT_MAPPED }

  // P2-4 (D-3, AC-14): one media session per stream, made by the database after checking cctv.live for this person once more (the
  // registry the gateway asks when the socket arrives and every 15 s afterwards). A camera it refuses is left out like any other
  // camera one may not watch; when it cannot be asked at all nothing is opened and no password is read (fail closed).
  let sids: Map<string, string>
  try {
    sids = await createMediaSessions(deps.admin, { orgId: actor.orgId, userId: actor.id, kind: 'live', cameras: routes.map((r) => ({ id: r.camera.id, stream: streamName({ c: r.camera.id, k: kind }) })) })
  } catch {
    logger.error({ event: 'open_streams_sessions_failed' })
    return { ok: false, error: MSG_FAILED }
  }
  const registered = routes.filter((r) => sids.has(r.camera.id))
  if (registered.length === 0) return { ok: true, streams: [] }

  const env = deps.env ?? process.env
  // One password read per recorder, and only for recorders that need one (a demo NVR has no real camera behind it).
  const passwords = new Map<string, string | null>()
  const recorders = [...new Map(registered.map((r) => [r.recorder.id, r.recorder])).values()]
  await mapLimit(recorders, 4, async (rec) => {
    if (isDemoRecorder(rec, env)) return
    const read = await readRecorderPassword(deps.admin, rec.id)
    if (!read.ok) logger.error({ event: 'open_streams_credential_failed', location: rec.code, recorder: rec.id, errorCode: read.code })
    passwords.set(rec.id, read.ok ? read.password : null)
  })

  const now = deps.now ?? Date.now
  const exp = Math.floor(now() / 1000) + TOKEN_LIFETIME_SEC
  let failed = 0
  const opened = await mapLimit(registered, REGISTER_PARALLEL, async ({ camera: c, recorder: rec }): Promise<OpenedStream | null> => {
    try {
      let src: string
      const demo = isDemoRecorder(rec, env)
      if (demo) src = demoSource(c.channel, c.id)
      else {
        const password = passwords.get(rec.id)
        if (!password || !rec.host) return null // no saved NVR password: this camera cannot be opened (and the others still can)
        src = buildRtspUrl({ host: rec.host, port: rec.rtsp_port, username: rec.username, password, channel: c.channel, kind })
      }
      // The stream is named by the camera, never by the channel: a remapped camera keeps its stream name (and its viewers' tokens).
      const name = streamName({ c: c.id, k: kind })
      await deps.go2rtc.register(name, src, { keepExisting: demo })
      const token = signStreamToken({ sid: sids.get(c.id)!, u: actor.id, c: c.id, k: kind, exp }, secret)
      return { cameraId: c.id, name: c.name, storeCode: c.code, channel: c.channel, token, kind }
    } catch {
      failed++
      logger.error({ event: 'open_stream_failed', location: c.code, recorder: rec.id, channel: c.channel, kind }) // no address, no error text: they can carry a password
      return null
    }
  })
  // Streams nobody has watched for a long time are removed from go2rtc (at most once a minute; never waits, never fails the request).
  void deps.go2rtc.prune({ now: now() }).catch(() => {})
  const streams = opened.filter((s): s is OpenedStream => s !== null)
  if (streams.length === 0 && failed > 0) return { ok: false, error: MSG_UNAVAILABLE }
  return { ok: true, streams }
}
