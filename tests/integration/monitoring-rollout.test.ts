import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { Actor } from '@/lib/admin/types'
import { loadNvrLoginProblems, loadRolloutOverview, setMonitoringRollout, tryNvrLoginAgain } from '@/lib/inventory/monitoring-rollout'
import { adminClient, cleanupOrg, createCluster, createOrg, createRegion, createSite, createUser, grant, type TestUser } from '../setup/fixtures'

// Final fix X (release 1 review C I-4, M-19; rulings NB-3, NB-4): the monitoring rollout and the NVR login problems as the
// administrators' screens use them (the services behind lib/actions/admin/monitoring.ts, whose fresh-sign-in guard is checked by
// tests/unit/fresh-auth-guard.test.ts).

const admin = () => adminClient()

describe('monitoring rollout and NVR login problems (services)', () => {
  let orgId: string
  let boss: TestUser
  let viewer: TestUser
  let actor: Actor
  let region: string
  let cluster: string
  const sites: Awaited<ReturnType<typeof createSite>>[] = []
  const clients = (u: TestUser) => ({ admin: admin(), rls: u.client })

  beforeAll(async () => {
    orgId = await createOrg()
    boss = await createUser(orgId, 'admin')
    await grant(orgId, boss.id, 'admin.inventory')
    viewer = await createUser(orgId, 'user')
    actor = { id: boss.id, orgId, role: 'admin' }
    region = await createRegion(orgId)
    cluster = await createCluster(orgId, region)
    for (let i = 0; i < 3; i++) sites.push(await createSite(orgId, { clusterId: i < 2 ? cluster : null, secret: 'pw-x', cameras: 0 }))
  })
  afterAll(() => cleanupOrg(orgId))

  it('the pilot steps: everything off, one location on, then its cluster, then the region; counts per node', async () => {
    expect(await setMonitoringRollout(clients(viewer), { id: viewer.id, orgId, role: 'user' }, { scope: 'organization', enabled: false, reason: 'before the pilot' }))
      .toMatchObject({ ok: false })
    expect(await setMonitoringRollout(clients(boss), actor, { scope: 'organization', enabled: false, reason: 'before the pilot' })).toEqual({ ok: true, matched: 3, changed: 3 })
    expect(await setMonitoringRollout(clients(boss), actor, { scope: 'location', scopeId: sites[0].locationId, enabled: true, reason: 'pilot' })).toEqual({ ok: true, matched: 1, changed: 1 })
    let o = await loadRolloutOverview(admin(), orgId)
    expect(o.totals).toEqual({ on: 1, off: 2 })
    expect(o.clusters.find((c) => c.id === cluster)).toMatchObject({ on: 1, off: 1 })
    expect(await setMonitoringRollout(clients(boss), actor, { scope: 'cluster', scopeId: cluster, enabled: true, reason: 'cluster next' })).toEqual({ ok: true, matched: 2, changed: 1 })
    expect(await setMonitoringRollout(clients(boss), actor, { scope: 'region', scopeId: region, enabled: true, reason: 'region next' })).toEqual({ ok: true, matched: 2, changed: 0 })
    o = await loadRolloutOverview(admin(), orgId)
    expect(o.regions.find((g) => g.id === region)).toMatchObject({ on: 2, off: 0 })
    expect(o.totals).toEqual({ on: 2, off: 1 })
    expect(await setMonitoringRollout(clients(boss), actor, { scope: 'region', scopeId: null, enabled: true, reason: 'x y z' })).toMatchObject({ ok: false })
    expect(await setMonitoringRollout(clients(boss), actor, { scope: 'cluster', scopeId: cluster, enabled: true, reason: 'x' })).toMatchObject({ ok: false })
  })

  it('a refused NVR login is listed (with its location, for the link), "Try again" ends the wait and is refused to a viewer', async () => {
    const r = sites[0].recorderId
    const w = admin()
    const g = (await w.rpc('nvr_login_gate', { p_recorders: [r], p_path: 'monitoring' })).data as unknown as { version: string }[]
    await w.rpc('nvr_login_report', { p_recorder: r, p_version: g[0].version, p_outcome: 'refused', p_path: 'monitoring' })
    const list = await loadNvrLoginProblems(admin(), orgId)
    expect(list).toHaveLength(1)
    expect(list[0]).toMatchObject({ recorderId: r, locationId: sites[0].locationId, state: 'refused', level: 1, lastPath: 'monitoring' })
    expect(await tryNvrLoginAgain(clients(viewer), { id: viewer.id, orgId, role: 'user' }, r)).toMatchObject({ ok: false })
    expect(await tryNvrLoginAgain(clients(boss), actor, r)).toEqual({ ok: true })
    expect(await loadNvrLoginProblems(admin(), orgId)).toEqual([])
  })
})
