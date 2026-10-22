import type { AddressInfo } from 'node:net'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import WebSocket from 'ws'
import { createGateway, type GatewayServer } from '@/lib/streams/gateway'
import { openStreams, renewStreams } from '@/lib/streams/open'
import { createRestRegistry } from '@/lib/streams/registry'
import { createTileConnection, type Connector, type TileConnection } from '@/lib/streams/tile-connection'
import { gatewaySocketUrl } from '@/lib/streams/wall'
import { startFakeGo2rtc, type FakeGo2rtc } from '../helpers/fake-go2rtc'
import { startFakeGo2rtcWs, waitFor, type FakeGo2rtcWs } from '../helpers/fake-go2rtc-ws'
import { adminClient, cleanupOrg, createOrg, createSite, createUser, grant, ORG_SCOPE, type TestUser } from '../setup/fixtures'

// P4-L1 brief item 2 ("cleanup on navigation: no leaked gateway sessions: test"). The wall's own connection logic
// (lib/streams/tile-connection.ts, what every LiveTile runs) drives REAL sockets through the REAL gateway, which asks the REAL session
// registry in the local database (P2-4); a fake go2rtc on loopback stands in for the video. Changing the page, hiding the tab and leaving
// the page must leave no socket open at the gateway and no session open in the registry. Loopback only: no NVR or camera is contacted.

const SECRET = 'live-wall-cleanup-secret-0123456789'
const APP = 'http://app.test:3212'
const admin = () => adminClient()

describe('the wall leaves nothing open behind it (P4-L1)', () => {
  let orgId: string
  let site: Awaited<ReturnType<typeof createSite>>
  let viewer: TestUser
  let api: FakeGo2rtc, video: FakeGo2rtcWs
  let gateway: GatewayServer, base: string
  const savedSecret = process.env.STREAM_TOKEN_SECRET
  const sockets: WebSocket[] = []

  /** The browser part, as a Node WebSocket: "playing" once the gateway let the socket through, "ended" when it closes. */
  const connector: Connector = (url, ev) => {
    const ws = new WebSocket(url, { origin: APP })
    sockets.push(ws)
    ws.on('open', () => ev.onPlaying())
    ws.on('close', () => ev.onEnded())
    ws.on('error', () => {})
    return () => ws.close()
  }
  const openNow = async () => {
    const { data, error } = await admin().from('media_sessions').select('id, camera_id').eq('user_id', viewer.id).not('opened_at', 'is', null).is('closed_at', null)
    if (error) throw new Error(error.message)
    return data ?? []
  }
  const upstreamOpen = () => video.connections.filter((c) => !c.closed).length
  async function tiles(cameraIds: string[]) {
    const res = await openStreams({ admin: admin(), rls: viewer.client, go2rtc: api.client, env: {} }, { id: viewer.id, orgId }, cameraIds, 'sub')
    if (!res.ok) throw new Error(res.error)
    const map = new Map<string, TileConnection>()
    for (const s of res.streams) {
      const t = createTileConnection({ connect: connector, onView: () => {} })
      t.update({ url: gatewaySocketUrl(base, s.token), paused: false })
      map.set(s.cameraId, t)
    }
    return { map, streams: res.streams }
  }

  beforeAll(async () => {
    process.env.STREAM_TOKEN_SECRET = SECRET
    orgId = await createOrg()
    site = await createSite(orgId, { host: '127.0.0.1', rtspPort: 15571, httpPort: 16571, username: 'cleanup-viewer', secret: 'nvr-pass-cleanup', cameras: 6 })
    viewer = await createUser(orgId, 'user')
    await grant(orgId, viewer.id, ['cctv.live'], ORG_SCOPE)
    api = await startFakeGo2rtc()
    video = await startFakeGo2rtcWs()
    gateway = createGateway({
      go2rtcUrl: video.url, secret: SECRET, allowedOrigins: [APP], validateEveryMs: 1000, autoValidate: true, maxSockets: 100, maxSocketsPerIp: 100, maxUpgradesPerMinute: 1000,
      registry: createRestRegistry({ url: process.env.NEXT_PUBLIC_SUPABASE_URL!, serviceKey: process.env.SUPABASE_SERVICE_ROLE_KEY! }),
    })
    const port = await new Promise<number>((resolve) => gateway.listen(0, '127.0.0.1', () => resolve((gateway.address() as AddressInfo).port)))
    base = `http://127.0.0.1:${port}`
  })
  afterAll(async () => {
    sockets.forEach((s) => s.terminate())
    await gateway?.shutdown(1000)
    await api?.close()
    await video?.close()
    if (savedSecret === undefined) delete process.env.STREAM_TOKEN_SECRET
    else process.env.STREAM_TOKEN_SECRET = savedSecret
    await cleanupOrg(orgId)
  })

  it('page change, hidden tab, coming back and leaving the page: gateway sockets and registry sessions are exactly the tiles that play', async () => {
    const ids = site.cameraIds
    // Page 1 (four tiles) plays.
    const page1 = await tiles(ids.slice(0, 4))
    await waitFor(() => upstreamOpen() === 4, 5000, 'page 1 to play')
    await waitFor(() => sockets.filter((s) => s.readyState === WebSocket.OPEN).length === 4, 5000, 'page 1 sockets')
    let open = await openNow()
    for (let i = 0; i < 20 && open.length < 4; i++) {
      await new Promise((r) => setTimeout(r, 100))
      open = await openNow()
    }
    expect(open.map((s) => s.camera_id).sort()).toEqual(ids.slice(0, 4).sort())

    // The next page: the old tiles go, the new ones come.
    for (const t of page1.map.values()) t.dispose()
    const page2 = await tiles(ids.slice(4, 6))
    await waitFor(() => upstreamOpen() === 2, 5000, 'only page 2 upstream')
    await waitFor(() => sockets.filter((s) => s.readyState === WebSocket.OPEN).length === 2, 5000, 'only page 2 sockets')
    await new Promise((r) => setTimeout(r, 300)) // the gateway has told the registry
    expect((await openNow()).map((s) => s.camera_id).sort()).toEqual(ids.slice(4, 6).sort())

    // The tab is hidden: nothing plays.
    for (const [id, t] of page2.map) t.update({ url: gatewaySocketUrl(base, page2.streams.find((s) => s.cameraId === id)!.token), paused: true })
    await waitFor(() => upstreamOpen() === 0, 5000, 'nothing upstream while hidden')
    await new Promise((r) => setTimeout(r, 300))
    expect(await openNow()).toEqual([])

    // Back to the tab: the wall's renewed tokens (P2-4: every minute) open new sessions.
    const renewed = await renewStreams({ admin: admin(), rls: viewer.client }, { id: viewer.id, orgId }, ids.slice(4, 6), 'sub')
    if (!renewed.ok) throw new Error(renewed.error)
    for (const r of renewed.tokens) page2.map.get(r.cameraId)!.update({ url: gatewaySocketUrl(base, r.token), paused: false })
    await waitFor(() => upstreamOpen() === 2, 5000, 'page 2 again')
    await new Promise((r) => setTimeout(r, 300))
    expect((await openNow()).map((s) => s.camera_id).sort()).toEqual(ids.slice(4, 6).sort())

    // Leaving the page: every tile goes.
    for (const t of page2.map.values()) t.dispose()
    await waitFor(() => upstreamOpen() === 0, 5000, 'nothing upstream after leaving')
    await waitFor(() => sockets.every((s) => s.readyState === WebSocket.CLOSED), 5000, 'every socket closed')
    await new Promise((r) => setTimeout(r, 300))
    expect(await openNow()).toEqual([])
    const { data } = await admin().rpc('media_sessions_live_open', { p_org: orgId, p_user: viewer.id })
    expect(data).toEqual([])
  })
})
