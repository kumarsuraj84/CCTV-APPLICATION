import { beforeEach, describe, expect, it, vi } from 'vitest'
import { auditAccess } from '@/lib/auth/access-audit'

// P2-2 brief item 7: best-effort audit of CCTV and monitoring operations (durable audit is P5). Actor, capability, camera/location ids
// and counts; never tokens, addresses, URLs with credentials or passwords; never breaks the operation.

function fakeAdmin(o: { fail?: 'error' | 'throw' } = {}) {
  const rows: Record<string, unknown>[] = []
  return {
    rows,
    client: {
      from: (table: string) => ({
        insert: async (row: Record<string, unknown>) => {
          if (o.fail === 'throw') throw new Error('socket closed rtsp://u:secret@10.0.0.1')
          rows.push({ table, ...row })
          return { error: o.fail === 'error' ? { message: 'nope' } : null }
        },
      }),
    } as never,
  }
}

beforeEach(() => {
  vi.spyOn(console, 'error').mockImplementation(() => {})
})

describe('auditAccess', () => {
  it('writes one audit row with the actor, the capability, the ids and the count', async () => {
    const a = fakeAdmin()
    await auditAccess(a.client, { orgId: 'o1', actorId: 'u1', action: 'cctv_live_opened', capability: 'cctv.live', cameraIds: ['c1', 'c2'], detail: { kind: 'sub' } })
    expect(a.rows).toEqual([
      { table: 'admin_audit_log', org_id: 'o1', actor_id: 'u1', action: 'cctv_live_opened', entity_type: null, entity_id: null, detail: { capability: 'cctv.live', cameraIds: ['c1', 'c2'], count: 2, kind: 'sub' } },
    ])
  })

  it('one camera becomes the entity of the row', async () => {
    const a = fakeAdmin()
    await auditAccess(a.client, { orgId: 'o1', actorId: 'u1', action: 'cctv_playback_opened', capability: 'cctv.playback', cameraIds: ['c1'] })
    expect(a.rows[0]).toMatchObject({ entity_type: 'camera', entity_id: 'c1', detail: { capability: 'cctv.playback', cameraIds: ['c1'], count: 1 } })
  })

  it('a location list is recorded as such', async () => {
    const a = fakeAdmin()
    await auditAccess(a.client, { orgId: 'o1', actorId: 'u1', action: 'check_requested', capability: 'it.monitoring.operate', locationIds: ['s1'] })
    expect(a.rows[0]).toMatchObject({ entity_type: 'store', entity_id: 's1', detail: { capability: 'it.monitoring.operate', locationIds: ['s1'], count: 1 } })
  })

  it('drops any detail field whose name or value looks like a secret, a token or an address', async () => {
    const a = fakeAdmin()
    await auditAccess(a.client, {
      orgId: 'o1', actorId: 'u1', action: 'cctv_export_started', capability: 'cctv.export', cameraIds: ['c1'],
      detail: { token: 'abc', password: 'x', url: 'rtsp://u:p@h/', minutes: 10, src: 'http://10.0.0.1/', note: 'ok' },
    })
    expect(a.rows[0].detail).toEqual({ capability: 'cctv.export', cameraIds: ['c1'], count: 1, minutes: 10, note: 'ok' })
  })

  it('never throws and never breaks the operation: a failed or throwing write is only logged, without its text', async () => {
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {})
    await expect(auditAccess(fakeAdmin({ fail: 'error' }).client, { orgId: 'o', actorId: 'u', action: 'x', capability: 'cctv.live' })).resolves.toBeUndefined()
    await expect(auditAccess(fakeAdmin({ fail: 'throw' }).client, { orgId: 'o', actorId: 'u', action: 'x', capability: 'cctv.live' })).resolves.toBeUndefined()
    const out = logged.mock.calls.map((c) => c.map(String).join(' ')).join('\n')
    expect(out).toContain('access_audit_failed')
    expect(out).not.toContain('secret')
    await expect(auditAccess({} as never, { orgId: 'o', actorId: 'u', action: 'x', capability: 'cctv.live' })).resolves.toBeUndefined()
  })
})
