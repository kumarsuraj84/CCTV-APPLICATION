// P5.4 brief item 5: the audit page's reads (lib/admin/audit-view.ts) against the local database: the filters and the search work, the
// rows come through the person's own sign-in (RLS: admin.audit.read in their organisation), names only from their organisation.
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { parseAuditFilters, readAuditPage } from '@/lib/admin/audit-view'
import { adminClient, cleanupOrg, createOrg, createUser, grant, type TestUser } from '../setup/fixtures'
import { serviceClient } from '../setup/service-keys'

const admin = () => adminClient()
const rowsOf = async (u: TestUser, org: string, sp: Record<string, string>) => {
  const r = await readAuditPage(u.client, serviceClient('app_web'), org, parseAuditFilters(sp))
  if ('error' in r) throw new Error(r.error)
  return r
}

describe('audit page reads (P5.4)', () => {
  let org: string
  let other: string
  let auditor: TestUser
  let nobody: TestUser
  let subject: TestUser

  beforeAll(async () => {
    org = await createOrg()
    other = await createOrg()
    auditor = await createUser(org, 'admin')
    await grant(org, auditor.id, ['admin.audit.read'])
    nobody = await createUser(org, 'admin')
    subject = await createUser(org, 'user')
    await admin().from('profiles').update({ full_name: 'Priya Subject' }).eq('id', subject.id)
    const rows = [
      { org_id: org, actor_id: auditor.id, action: 'inventory_archived', entity_type: 'camera', entity_id: subject.id, detail: { archived_at: 'x' }, created_at: '2026-10-01T10:00:00Z' },
      { org_id: org, actor_id: auditor.id, action: 'access_granted', entity_type: 'profile', entity_id: subject.id, detail: { count: 2 }, created_at: '2026-10-05T10:00:00Z' },
      { org_id: org, actor_id: subject.id, action: 'cctv_live_opened', entity_type: 'camera', entity_id: null, detail: { count: 1 }, created_at: '2026-10-10T10:00:00Z' },
      { org_id: other, actor_id: auditor.id, action: 'access_granted', entity_type: 'profile', entity_id: null, detail: {}, created_at: '2026-10-05T10:00:00Z' },
    ]
    const { error } = await admin().from('admin_audit_log').insert(rows)
    if (error) throw new Error(error.message)
    const ev = await admin().rpc('auth_event_record', { p_event: 'sign_in', p_user: subject.id, p_email: null, p_email_hash: null, p_actor: null, p_ip: '10.9.8.7', p_user_agent: null, p_detail: {} } as never)
    if (ev.error) throw new Error(ev.error.message)
  })
  afterAll(async () => {
    await cleanupOrg(org)
    await cleanupOrg(other)
  })

  it('newest first, with plain labels and names; nothing of another organisation', async () => {
    const r = await rowsOf(auditor, org, {})
    expect(r.rows.map((x) => x.action)).toEqual(['cctv_live_opened', 'access_granted', 'inventory_archived'])
    expect(r.rows.map((x) => x.what)).toEqual(['Live video opened', 'Access given', 'Archived'])
    expect(r.rows[1].target).toContain('Priya Subject')
    expect(r.rows[0].who).toContain('Priya Subject')
    expect(r.hasMore).toBe(false)
  })

  it('filters: one action, a category, a person, a day range (India time), a search', async () => {
    expect((await rowsOf(auditor, org, { action: 'access_granted' })).rows.map((x) => x.action)).toEqual(['access_granted'])
    expect((await rowsOf(auditor, org, { category: 'video' })).rows.map((x) => x.action)).toEqual(['cctv_live_opened'])
    expect((await rowsOf(auditor, org, { person: 'priya' })).rows.map((x) => x.action)).toEqual(['cctv_live_opened', 'access_granted', 'inventory_archived'])
    expect((await rowsOf(auditor, org, { person: 'nobody-like-this' })).rows).toEqual([])
    expect((await rowsOf(auditor, org, { from: '2026-10-02', to: '2026-10-05' })).rows.map((x) => x.action)).toEqual(['access_granted'])
    expect((await rowsOf(auditor, org, { q: 'archiv' })).rows.map((x) => x.action)).toEqual(['inventory_archived'])
  })

  it('sign-ins are a list of their own, with the address they came from', async () => {
    const r = await rowsOf(auditor, org, { kind: 'sign_ins' })
    expect(r.rows.map((x) => [x.action, x.what])).toEqual([['sign_in', 'Signed in']])
    expect(r.rows[0].target).toBe('from 10.9.8.7')
    expect((await rowsOf(auditor, org, { kind: 'sign_ins', q: '10.9.8' })).rows).toHaveLength(1)
  })

  it('an administrator without admin.audit.read reads nothing (the database refuses the rows)', async () => {
    expect((await rowsOf(nobody, org, {})).rows).toEqual([])
    expect((await rowsOf(nobody, org, { kind: 'sign_ins' })).rows).toEqual([])
  })
})
