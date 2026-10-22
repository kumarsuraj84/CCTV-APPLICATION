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

  it('ignores a new request while one is already waiting or running, when the worker is alive', async () => {
    const asked = new Date(Date.now() - 20_000).toISOString()
    // Waiting: asked, and the last run began before the request.
    await adminClient()
      .from('worker_state')
      .update({ last_heartbeat: new Date().toISOString(), check_requested_at: asked, run_started_at: new Date(Date.now() - 60_000).toISOString(), run_finished_at: new Date(Date.now() - 50_000).toISOString() })
      .eq('id', 1)
    const actor = { id: crypto.randomUUID(), orgId, role: 'admin' as const }
    const waiting = await requestCheckNow(adminClient(), actor)
    expect(waiting).toEqual({ ok: true, alreadyOnTheWay: true })
    expect(new Date((await state()).check_requested_at!).toISOString()).toBe(asked)

    // Running: a run began after the request and has not finished.
    await adminClient().from('worker_state').update({ run_started_at: new Date(Date.now() - 5_000).toISOString(), run_finished_at: null }).eq('id', 1)
    expect(await requestCheckNow(adminClient(), actor)).toEqual({ ok: true, alreadyOnTheWay: true })
    expect(new Date((await state()).check_requested_at!).toISOString()).toBe(asked)

    // Nothing of this was recorded as a new request.
    const audit = await adminClient().from('admin_audit_log').select('action').eq('org_id', orgId).eq('actor_id', actor.id)
    expect(audit.data).toEqual([])

    // Finished: a new request is accepted.
    await adminClient().from('worker_state').update({ run_finished_at: new Date().toISOString() }).eq('id', 1)
    expect(await requestCheckNow(adminClient(), actor)).toEqual({ ok: true })
    expect(new Date((await state()).check_requested_at!).getTime()).toBeGreaterThan(new Date(asked).getTime())
  })

  it('records a new request when the worker is not running, even if an old one is still waiting', async () => {
    const asked = new Date(Date.now() - 3600_000).toISOString()
    await adminClient().from('worker_state').update({ last_heartbeat: new Date(Date.now() - 600_000).toISOString(), check_requested_at: asked, run_started_at: null, run_finished_at: null }).eq('id', 1)
    expect(await requestCheckNow(adminClient(), { id: crypto.randomUUID(), orgId, role: 'admin' })).toEqual({ ok: true })
    expect(new Date((await state()).check_requested_at!).getTime()).toBeGreaterThan(new Date(asked).getTime())
  })
})
