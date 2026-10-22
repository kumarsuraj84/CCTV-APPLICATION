import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { requestCheckNow } from '@/lib/monitor/check-now'
import { adminClient, cleanupOrg, createOrg, createUser } from '../setup/fixtures'

const state = async () => (await adminClient().from('worker_state').select('*').eq('id', 1).single()).data!

describe('check now', () => {
  let orgId: string
  let saved: Awaited<ReturnType<typeof state>>
  beforeAll(async () => {
    saved = await state()
    orgId = await createOrg()
  })
  afterAll(async () => {
    await adminClient().from('worker_state').update(saved).eq('id', 1)
    await cleanupOrg(orgId)
  })

  it('operators, admins and owners may ask; viewers and managers may not', async () => {
    // A quiet worker: nothing pending, nothing running, no recent heartbeat.
    await adminClient().from('worker_state').update({ last_heartbeat: null, run_started_at: null, run_finished_at: null, check_requested_at: null }).eq('id', 1)
    for (const role of ['user', 'manager'] as const) {
      expect((await requestCheckNow(adminClient(), { id: crypto.randomUUID(), orgId, role })).ok).toBe(false)
    }
    // Refused people leave no trace: no request, no audit entry.
    expect((await state()).check_requested_at).toBeNull()
    expect((await adminClient().from('admin_audit_log').select('id').eq('org_id', orgId)).data).toEqual([])

    const before = (await state()).check_requested_at
    const person = await createUser(orgId, 'agent')
    const res = await requestCheckNow(adminClient(), { id: person.id, orgId, role: 'agent' })
    expect(res.ok).toBe(true)
    const after = (await state()).check_requested_at
    expect(after).not.toBe(before)
    expect(Date.now() - new Date(after!).getTime()).toBeLessThan(10_000)
    const audit = await adminClient().from('admin_audit_log').select('action, actor_id').eq('org_id', orgId)
    expect(audit.data).toEqual([{ action: 'check_requested', actor_id: person.id }])
  })

  it('admins and platform owners may ask too', async () => {
    await adminClient().from('worker_state').update({ last_heartbeat: null, run_started_at: null, run_finished_at: null, check_requested_at: null }).eq('id', 1)
    for (const role of ['admin', 'platform_owner'] as const) {
      const r = await requestCheckNow(adminClient(), { id: crypto.randomUUID(), orgId, role })
      expect(r.ok).toBe(true)
      expect(r).not.toHaveProperty('alreadyOnTheWay')
      await adminClient().from('worker_state').update({ check_requested_at: null }).eq('id', 1)
    }
  })

  it('ignores a new request only while one is waiting, and only when the worker is alive', async () => {
    const asked = new Date(Date.now() - 20_000).toISOString()
    // Waiting: asked, and the last run began (and ended) before the request.
    await adminClient()
      .from('worker_state')
      .update({ last_heartbeat: new Date().toISOString(), check_requested_at: asked, run_started_at: new Date(Date.now() - 120_000).toISOString(), run_finished_at: new Date(Date.now() - 100_000).toISOString() })
      .eq('id', 1)
    const actor = { id: crypto.randomUUID(), orgId, role: 'admin' as const }
    expect(await requestCheckNow(adminClient(), actor)).toEqual({ ok: true, alreadyOnTheWay: true })
    expect(new Date((await state()).check_requested_at!).toISOString()).toBe(asked)
    // Nothing of this was recorded as a new request.
    expect((await adminClient().from('admin_audit_log').select('action').eq('org_id', orgId).eq('actor_id', actor.id)).data).toEqual([])
  })

  it('accepts a request while a run is only running, so that the runner repeats it afterwards', async () => {
    const asked = new Date(Date.now() - 20_000).toISOString()
    // Running: a run began after the earlier request and has not finished.
    await adminClient()
      .from('worker_state')
      .update({ last_heartbeat: new Date().toISOString(), check_requested_at: asked, run_started_at: new Date(Date.now() - 5_000).toISOString(), run_finished_at: null })
      .eq('id', 1)
    const actor = { id: crypto.randomUUID(), orgId, role: 'admin' as const }
    expect(await requestCheckNow(adminClient(), actor)).toEqual({ ok: true })
    const s = await state()
    expect(new Date(s.check_requested_at!).getTime()).toBeGreaterThan(new Date(s.run_started_at!).getTime()) // the runner sees "asked after the run began"
    expect((await adminClient().from('admin_audit_log').select('action').eq('org_id', orgId).eq('actor_id', actor.id)).data).toEqual([{ action: 'check_requested' }])
    // Pressed again while that second request is waiting: ignored.
    expect(await requestCheckNow(adminClient(), actor)).toEqual({ ok: true, alreadyOnTheWay: true })
    expect((await adminClient().from('admin_audit_log').select('action').eq('org_id', orgId).eq('actor_id', actor.id)).data).toHaveLength(1)
  })

  it('accepts a new request once the last run finished a while ago', async () => {
    const asked = new Date(Date.now() - 120_000).toISOString()
    await adminClient()
      .from('worker_state')
      .update({ last_heartbeat: new Date().toISOString(), check_requested_at: asked, run_started_at: new Date(Date.now() - 100_000).toISOString(), run_finished_at: new Date(Date.now() - 60_000).toISOString() })
      .eq('id', 1)
    expect(await requestCheckNow(adminClient(), { id: crypto.randomUUID(), orgId, role: 'admin' })).toEqual({ ok: true })
    expect(new Date((await state()).check_requested_at!).getTime()).toBeGreaterThan(new Date(asked).getTime())
  })

  it('refuses a request for 30 seconds after a run finished, by the clock it is given', async () => {
    const finished = new Date('2026-01-01T00:00:10.000Z')
    const row = { last_heartbeat: finished.toISOString(), check_requested_at: '2026-01-01T00:00:00.000Z', run_started_at: '2026-01-01T00:00:05.000Z', run_finished_at: finished.toISOString() }
    const actor = { id: crypto.randomUUID(), orgId, role: 'agent' as const }
    await adminClient().from('worker_state').update(row).eq('id', 1)
    const refused = await requestCheckNow(adminClient(), actor, () => finished.getTime() + 10_000)
    expect(refused).toEqual({ ok: false, error: 'A check just finished. Try again in a moment.' })
    expect(new Date((await state()).check_requested_at!).toISOString()).toBe(row.check_requested_at) // nothing was written
    expect((await adminClient().from('admin_audit_log').select('action').eq('org_id', orgId).eq('actor_id', actor.id)).data).toEqual([])
    // Just inside and just outside the limit.
    expect((await requestCheckNow(adminClient(), actor, () => finished.getTime() + 29_999)).ok).toBe(false)
    expect((await requestCheckNow(adminClient(), actor, () => finished.getTime() + 30_000)).ok).toBe(true)
  })

  it('does not apply the cooldown to a run that is still open', async () => {
    await adminClient()
      .from('worker_state')
      .update({ last_heartbeat: new Date().toISOString(), check_requested_at: new Date(Date.now() - 20_000).toISOString(), run_started_at: new Date(Date.now() - 2_000).toISOString(), run_finished_at: new Date(Date.now() - 3_000).toISOString() })
      .eq('id', 1)
    // The recorded finish belongs to an earlier run (it is before the start), so this run is open and not in cooldown.
    expect((await requestCheckNow(adminClient(), { id: crypto.randomUUID(), orgId, role: 'admin' })).ok).toBe(true)
  })

  it('records a new request when the worker is not running, even if an old one is still waiting', async () => {
    const asked = new Date(Date.now() - 3600_000).toISOString()
    await adminClient().from('worker_state').update({ last_heartbeat: new Date(Date.now() - 600_000).toISOString(), check_requested_at: asked, run_started_at: null, run_finished_at: null }).eq('id', 1)
    expect(await requestCheckNow(adminClient(), { id: crypto.randomUUID(), orgId, role: 'admin' })).toEqual({ ok: true })
    expect(new Date((await state()).check_requested_at!).getTime()).toBeGreaterThan(new Date(asked).getTime())
  })
})
