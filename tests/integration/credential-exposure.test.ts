import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  adminClient, atLocation, cleanupOrg, createAsset, createCamera, createOrg, createSite, createUser, grant, ORG_SCOPE, type TestUser,
} from '../setup/fixtures'
import { rest } from '../setup/service-keys'

// P2-6 brief item 3 (AC-10, SO-3): no table or view a signed-in person can read exposes an NVR address, login name, vault pointer,
// password, a camera's address or an asset's address to a person who holds only CCTV rights. Probed through PostgREST with the
// person's REAL session key, for EVERY relation of schema public (the service role's API description lists them all), plus the
// API description the person's own key gets (what PostgREST says they may read: the information_schema view of the API).
// The check is by VALUE, not by column name: whatever a column is called, the known secret values must not appear anywhere.

const admin = () => adminClient()

async function sessionKey(u: TestUser): Promise<string> {
  const { data } = await u.client.auth.getSession()
  const key = data.session?.access_token
  if (!key) throw new Error('no session')
  return key
}

/** Every table and view of schema public with all its columns (the service role's API description lists them all). */
async function allRelations(): Promise<Map<string, string[]>> {
  const res = await rest(process.env.SUPABASE_SERVICE_ROLE_KEY!, '/')
  const defs = (res.body as { definitions?: Record<string, { properties?: Record<string, unknown> }> }).definitions ?? {}
  return new Map(Object.entries(defs).map(([name, d]) => [name, Object.keys(d.properties ?? {})]))
}

describe('credential exposure to CCTV-only people (P2-6, AC-10)', () => {
  let orgId: string
  let orgViewer: TestUser
  let locationViewer: TestUser
  let itViewer: TestUser
  let cameraId: string
  let secretId: string
  const secret = `Expo-${randomUUID()}`
  const nvrHost = '10.91.7.31'
  const nvrUser = `nvrlogin${randomUUID().slice(0, 6)}`
  const cameraIp = '10.91.7.77'
  const assetIp = '10.91.7.88'

  beforeAll(async () => {
    orgId = await createOrg()
    const site = await createSite(orgId, { host: nvrHost, username: nvrUser, secret, cameras: 0 })
    cameraId = await createCamera(orgId, { locationId: site.locationId, recorderId: site.recorderId, channel: 1, cameraIp })
    await createAsset(orgId, { locationId: site.locationId, type: 'server', ip: assetIp, port: 443 })
    secretId = (await admin().from('recorders').select('secret_id').eq('id', site.recorderId).single()).data!.secret_id as string
    expect(secretId).toBeTruthy()
    orgViewer = await createUser(orgId, 'user')
    await grant(orgId, orgViewer.id, ['cctv.live', 'cctv.playback'], ORG_SCOPE)
    locationViewer = await createUser(orgId, 'operator')
    await grant(orgId, locationViewer.id, ['cctv.live'], atLocation(site.locationId))
    // The control: someone with the IT view may see addresses (proves the probe can see them when allowed).
    itViewer = await createUser(orgId, 'manager')
    await grant(orgId, itViewer.id, ['it.inventory.view'], ORG_SCOPE)
  })
  afterAll(() => cleanupOrg(orgId))

  const sensitive = () => [secret, secretId, nvrHost, nvrUser, cameraIp, assetIp]

  async function probe(u: TestUser): Promise<{ readable: string[]; leaks: string[]; sawCamera: boolean }> {
    const key = await sessionKey(u)
    const readable: string[] = []
    const leaks: string[] = []
    let sawCamera = false
    const look = (where: string, body: unknown) => {
      const text = JSON.stringify(body)
      for (const s of sensitive()) if (text.includes(s)) leaks.push(`${where} shows ${s === secret ? 'the password' : s === secretId ? 'the vault pointer' : s}`)
      return text
    }
    for (const [r, columns] of await allRelations()) {
      const res = await rest(key, `/${r}?select=*&limit=1000`)
      if (res.status === 200) {
        readable.push(r)
        if (r === 'cameras' && look(r, res.body).includes(cameraId)) sawCamera = true
        else look(r, res.body)
        continue
      }
      expect([401, 403, 404], `${r}: ${res.status}`).toContain(res.status)
      // Column privileges: `*` is refused when any column is closed; every column is then asked for on its own.
      let anyColumn = false
      for (const c of columns) {
        const one = await rest(key, `/${r}?select=${c}&limit=1000`)
        if (one.status !== 200) continue
        anyColumn = true
        const text = look(`${r}.${c}`, one.body)
        if (r === 'cameras' && c === 'id' && text.includes(cameraId)) sawCamera = true
      }
      if (anyColumn) readable.push(r)
    }
    // The API description the person's own key gets lists only what they may read; probe those too (a view PostgREST would show).
    const described = await rest(key, '/')
    for (const p of Object.keys((described.body as { paths?: object }).paths ?? {})) {
      if (p === '/' || p.startsWith('/rpc/')) continue
      const res = await rest(key, `${p}?select=*&limit=1000`)
      if (res.status !== 200) continue
      const text = JSON.stringify(res.body)
      for (const s of sensitive()) if (text.includes(s)) leaks.push(`${p} shows ${s === secret ? 'the password' : s === secretId ? 'the vault pointer' : s}`)
    }
    return { readable, leaks, sawCamera }
  }

  it('a person with CCTV rights for the whole organisation reads cameras but no address, login, vault pointer or password', async () => {
    const { leaks, sawCamera, readable } = await probe(orgViewer)
    expect(sawCamera).toBe(true) // the probe is not empty: the camera itself is visible
    expect(readable).toContain('cameras')
    expect(leaks).toEqual([])
  })

  it('a person with CCTV rights for one location sees nothing more', async () => {
    const { leaks, sawCamera } = await probe(locationViewer)
    expect(sawCamera).toBe(true)
    expect(leaks).toEqual([])
  })

  it('the endpoint views answer nothing to CCTV-only people, and the server-only tables are closed', async () => {
    const key = await sessionKey(orgViewer)
    for (const v of ['recorder_endpoints', 'camera_endpoints']) {
      const res = await rest(key, `/${v}?select=*`)
      expect(res.status, v).toBe(200)
      expect(res.body, v).toEqual([])
    }
    for (const t of ['recorders', 'assets', 'asset_endpoints', 'network_definitions', 'camera_channel_mappings']) {
      const res = await rest(key, `/${t}?select=*`)
      expect(res.status === 200 ? res.body : [], t).toEqual([])
    }
    for (const t of ['vault_reads', 'rate_limit_hits', 'security_settings', 'media_sessions', 'worker_state', 'monitor_gaps']) {
      expect((await rest(key, `/${t}?select=*`)).status, t).toBeGreaterThanOrEqual(401)
    }
    // cameras: the address column is not selectable at all by signed-in people.
    expect(((await rest(key, '/cameras?select=camera_ip')).body as { code?: string }).code).toBe('42501')
  })

  it('control: someone with the IT view does see the NVR address and login name (never the password or the vault pointer)', async () => {
    const key = await sessionKey(itViewer)
    const text = JSON.stringify((await rest(key, '/recorder_endpoints?select=*')).body) + JSON.stringify((await rest(key, '/recorders?select=*')).body)
    expect(text).toContain(nvrHost)
    expect(text).toContain(nvrUser)
    const all = await probe(itViewer)
    expect(all.leaks.filter((l) => l.includes('password') || l.includes('vault pointer'))).toEqual([])
  })
})
