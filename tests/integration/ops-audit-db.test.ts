// P5.4 (migration 20261021000041_p54_ops_audit.sql) against the local database:
//   - admin_audit_log is append-only (brief item 5): no UPDATE, DELETE or TRUNCATE for any API role, the service role included; only
//     the test/demo clean-up function may empty a test organisation's rows;
//   - the housekeeping prunes record when they last ran (brief item 3: "media-session cleanup last run" on the Health page) under the
//     role that ran them, the worker's own role monitor_worker;
//   - ops_health_status(): the database clock, the migration level, the Vault round trip and the housekeeping runs, for the web app's
//     role and the service role only.
import { readdirSync } from 'node:fs'
import path from 'node:path'
import { createClient } from '@supabase/supabase-js'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { Database } from '@/types/database'
import { adminClient, cleanupOrg, createOrg, createUser, type TestUser } from '../setup/fixtures'
import { serviceClient } from '../setup/service-keys'

type Rpc = (fn: string, args?: Record<string, unknown>) => PromiseLike<{ data: unknown; error: { code?: string; message: string } | null }>
const rpcOf = (c: { rpc: unknown }): Rpc => (fn, args) => (c.rpc as (f: string, a?: unknown) => PromiseLike<{ data: unknown; error: { code?: string; message: string } | null }>)(fn, args ?? {})
const admin = () => adminClient()
const highestMigration = () =>
  readdirSync(path.resolve(__dirname, '../../supabase/migrations')).filter((f) => /^\d{14}_.+\.sql$/.test(f)).map((f) => f.slice(0, 14)).sort().at(-1)

type Health = {
  db_time: string
  migration: { level: string | null; applied: number }
  vault: { ok: boolean }
  housekeeping: { task: string; last_run_at: string; removed: number; db_role: string }[]
}

describe('P5.4 audit append-only, housekeeping record, ops health (migration 0041)', () => {
  let org: string
  let other: string
  let person: TestUser
  let row: string

  beforeAll(async () => {
    org = await createOrg()
    other = await createOrg()
    person = await createUser(org, 'admin')
    const { data, error } = await admin().from('admin_audit_log').insert({ org_id: org, actor_id: person.id, action: 'p54_test_row', detail: { n: 1 } }).select('id').single()
    if (error || !data) throw new Error(`audit insert: ${error?.message}`)
    row = data.id
  })
  afterAll(async () => {
    await cleanupOrg(org)
    await cleanupOrg(other)
  })

  it('no API role may change or delete an audit row: not the service role, not the web app, not the video path', async () => {
    const svc = await admin().from('admin_audit_log').update({ action: 'changed' }).eq('id', row).select('id')
    expect(svc.error?.code).toBe('42501')
    const del = await admin().from('admin_audit_log').delete().eq('id', row).select('id')
    expect(del.error?.code).toBe('42501')
    for (const role of ['app_web', 'media_service'] as const) {
      const c = serviceClient(role)
      expect((await c.from('admin_audit_log').update({ action: 'changed' }).eq('id', row).select('id')).error?.code, role).toBe('42501')
      expect((await c.from('admin_audit_log').delete().eq('id', row).select('id')).error?.code, role).toBe('42501')
    }
    // A signed-in administrator reads (RLS) but never writes.
    expect((await person.client.from('admin_audit_log').update({ action: 'changed' }).eq('id', row).select('id')).error?.code).toBe('42501')
    const still = (await admin().from('admin_audit_log').select('action, detail').eq('id', row).single()).data
    expect(still).toEqual({ action: 'p54_test_row', detail: { n: 1 } })
    // Writing new rows keeps working for the roles that write them.
    expect((await serviceClient('app_web').from('admin_audit_log').insert({ org_id: org, actor_id: person.id, action: 'p54_web_row' })).error).toBeNull()
    expect((await serviceClient('media_service').from('admin_audit_log').insert({ org_id: org, actor_id: person.id, action: 'p54_media_row' })).error).toBeNull()
  })

  it('the guards are in place: update, delete and truncate triggers on admin_audit_log and auth_events, no write privilege for any role', async () => {
    const { data, error } = await rpcOf(admin())('audit_guard_status')
    expect(error).toBeNull()
    expect(data).toEqual({
      admin_audit_log: { update_blocked: true, delete_blocked: true, truncate_blocked: true, writers: [] },
      auth_events: { update_blocked: true, delete_blocked: true, truncate_blocked: true, writers: [] },
      vault_reads: { writers: [] },
    })
    expect((await rpcOf(serviceClient('app_web'))('audit_guard_status')).error?.code).toBe('42501')
  })

  it('the clean-up of a test organisation may empty its audit rows; any other organisation is refused', async () => {
    const real = (await admin().from('organizations').select('id').not('slug', 'like', 'test-%').neq('slug', 'demo-sample-data').limit(1).maybeSingle()).data
    if (real) expect((await rpcOf(admin())('audit_purge_test_org', { p_org: real.id })).error?.code).toBe('42501')
    expect((await admin().from('admin_audit_log').insert({ org_id: other, actor_id: person.id, action: 'p54_other' })).error).toBeNull()
    const r = await rpcOf(admin())('audit_purge_test_org', { p_org: other })
    expect(r.error).toBeNull()
    expect(r.data).toBe(1)
    expect((await admin().from('admin_audit_log').select('id').eq('org_id', other)).data).toEqual([])
    // The flag the clean-up sets is not enough on its own: only the clean-up function (the table owner) may delete.
    expect((await rpcOf(serviceClient('app_web'))('audit_purge_test_org', { p_org: org })).error?.code).toBe('42501')
  })

  it('the worker records each housekeeping run under its own role, and ops_health_status shows it', async () => {
    const worker = rpcOf(serviceClient('monitor_worker'))
    const before = Date.now() - 5000
    for (const task of ['media_sessions_prune', 'rate_limit_prune', 'vault_reads_prune']) {
      const r = await worker(task)
      expect(r.error, task).toBeNull()
    }
    const h = await rpcOf(serviceClient('app_web'))('ops_health_status')
    expect(h.error).toBeNull()
    const health = h.data as Health
    const tasks = new Map(health.housekeeping.map((t) => [t.task, t]))
    for (const task of ['media_sessions_prune', 'rate_limit_prune', 'vault_reads_prune']) {
      const t = tasks.get(task)
      expect(t, task).toBeDefined()
      expect(t!.db_role, task).toBe('monitor_worker')
      expect(Date.parse(t!.last_run_at), task).toBeGreaterThan(before)
      expect(Number.isInteger(t!.removed), task).toBe(true)
    }
  })

  it('ops_health_status: database clock, migration level equal to the highest migration file, a working Vault', async () => {
    const h = await rpcOf(serviceClient('app_web'))('ops_health_status')
    expect(h.error).toBeNull()
    const health = h.data as Health
    expect(Math.abs(Date.parse(health.db_time) - Date.now())).toBeLessThan(60_000)
    expect(health.migration.level).toBe(highestMigration())
    expect(health.migration.applied).toBeGreaterThanOrEqual(41)
    expect(health.vault).toEqual({ ok: true })
    // Nothing secret in the answer: no secret value, no key, only the canary's verdict.
    expect(JSON.stringify(health)).not.toMatch(/canary-v1|decrypted/i)
  })

  it('ops_health_status is for the web app and the service role only', async () => {
    const anon = createClient<Database>(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!, { auth: { persistSession: false } })
    expect((await rpcOf(anon)('ops_health_status')).error?.code).toBe('42501')
    expect((await rpcOf(person.client)('ops_health_status')).error?.code).toBe('42501')
    for (const role of ['media_service', 'monitor_worker', 'video_gateway'] as const) {
      expect((await rpcOf(serviceClient(role))('ops_health_status')).error?.code, role).toBe('42501')
    }
    expect((await rpcOf(admin())('ops_health_status')).error).toBeNull()
  })

  it('privilege_violations() stays empty', async () => {
    const v = await rpcOf(admin())('privilege_violations')
    expect(v.error).toBeNull()
    expect(v.data).toEqual([])
  })
})
