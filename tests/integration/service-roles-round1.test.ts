import { execFileSync, spawnSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { adminClient, cleanupOrg, createOrg, createSite, createUser, type TestUser } from '../setup/fixtures'
import { serviceClient } from '../setup/service-keys'

// P2-6 review round 1 (migration 20261021000035): the database half of the fixes.
//   M-1  app_web may update only the columns of recorders and profiles the web code writes, and an exact snapshot of the table and
//        column grants of the four service roles (a later "GRANT ALL" would fail here);
//   M-2  media_service holds no rate-limit function; M-3 the start-up check's count of organisations that did not lock the service
//        key out of NVR logins; M-5 a GoTrue user can never carry a service role; M-10 refused credential reads leave a server log line.

type Rpc = Parameters<ReturnType<typeof adminClient>['rpc']>[0]
const call = (c: ReturnType<typeof adminClient>, fn: string, args: object = {}) =>
  c.rpc(fn as Rpc, args as never) as unknown as PromiseLike<{ data: unknown; error: { code?: string; message: string } | null }>
const code = (r: { error: { code?: string } | null }) => r.error?.code ?? null

const SELECT_WEB = [
  'access_grant_reviews', 'access_grants', 'access_migration_report', 'address_spaces', 'asset_dependencies', 'asset_endpoints', 'assets',
  'camera_channel_mappings', 'camera_endpoints', 'camera_group_items', 'camera_group_rules', 'camera_groups', 'cameras', 'capabilities',
  'check_state', 'clusters', 'device_capabilities', 'discovery_findings', 'location_status', 'locations', 'media_sessions', 'monitor_gaps',
  'network_definitions', 'organizations', 'outages', 'profiles', 'recorder_status', 'recorders', 'regions', 'worker_state',
  // P2-7 (20261021000036): the web app reads the worker lease (holder, token, age) for the worker status; nobody writes it directly.
  'worker_leases',
  // Final fix X (20261021000048, ruling NB-3): the web app reads the shared NVR login state for the Monitoring page; only the login
  // functions write it.
  'nvr_login_state',
]
const INSERT_WEB = [
  'admin_audit_log', 'asset_dependencies', 'asset_endpoints', 'camera_group_items', 'camera_group_rules', 'camera_groups',
  // Final fix Y (review A M-7, 20261021000049): no INSERT on profiles any more: a person is created through create_person.
  'network_definitions',
]
const UPDATE_WEB = ['asset_endpoints', 'camera_group_items', 'camera_groups', 'discovery_findings', 'network_definitions']
// Final clean-up (Y-R4, 20261021000051): the inventory tables by column grants only; never the archive state, the organisation (on an
// update) or the ids (archiving, restoring and moving go through the audited functions; trigger inventory_write_guard).
const ASSET_COLUMNS = ['location_id', 'type', 'name', 'ip', 'tcp_port', 'enabled', 'notes', 'address_space_id', 'mac', 'serial', 'vendor', 'model', 'firmware',
  'role', 'owner', 'criticality', 'lifecycle_state', 'warranty_until', 'management_mode', 'config_owner', 'credential_ref', 'assigned_profile_id',
  'attached_recorder_id', 'capability_discovered_at', 'last_inventory_at']
const INVENTORY_COLUMNS: Record<string, { insert: string[]; update: string[] }> = {
  regions: { insert: ['org_id', 'code', 'name'], update: ['code', 'name'] },
  clusters: { insert: ['org_id', 'region_id', 'code', 'name'], update: ['region_id', 'code', 'name'] },
  locations: {
    insert: ['org_id', 'code', 'name', 'kind', 'city', 'address', 'zone', 'state', 'is_active', 'cluster_id', 'parent_location_id', 'uplink_asset_id'],
    update: ['code', 'name', 'kind', 'city', 'address', 'zone', 'state', 'is_active', 'cluster_id', 'parent_location_id', 'uplink_asset_id'],
  },
  cameras: { insert: ['org_id', 'location_id', 'recorder_id', 'channel', 'name', 'camera_ip', 'is_active'], update: ['location_id', 'recorder_id', 'channel', 'name', 'camera_ip', 'is_active'] },
  assets: { insert: ['org_id', ...ASSET_COLUMNS], update: ASSET_COLUMNS },
}
const DELETE_WEB = ['asset_dependencies', 'camera_group_items', 'camera_group_rules', 'camera_groups', 'network_definitions']

/** The expected grants, one line each: "role PRIVILEGE relation" or "role PRIVILEGE relation(column)". */
function expectedGrants(): string[] {
  const lines: string[] = []
  const add = (role: string, priv: string, rels: string[]) => rels.forEach((r) => lines.push(`${role} ${priv} ${r}`))
  add('app_web', 'SELECT', SELECT_WEB)
  add('app_web', 'INSERT', INSERT_WEB)
  add('app_web', 'UPDATE', UPDATE_WEB)
  add('app_web', 'DELETE', DELETE_WEB)
  add('app_web', 'UPDATE', ['profiles(full_name)', 'profiles(location_id)', 'profiles(must_reset_password)', 'recorders(clock_offset_sec)', 'recorders(clock_offset_source)'])
  for (const [table, cols] of Object.entries(INVENTORY_COLUMNS)) {
    add('app_web', 'INSERT', cols.insert.map((c) => `${table}(${c})`))
    add('app_web', 'UPDATE', cols.update.map((c) => `${table}(${c})`))
  }
  add('media_service', 'SELECT', ['assets', 'camera_channel_mappings', 'cameras', 'locations', 'recorders'])
  add('media_service', 'INSERT', ['admin_audit_log'])
  add('monitor_worker', 'SELECT', ['assets', 'camera_channel_mappings', 'cameras', 'check_state', 'locations', 'recorders', 'worker_state'])
  // P2-7 (D-8, 20261021000036): the worker's direct writes of P2-6 (monitor_gaps INSERT, cameras.camera_ip and its worker_state
  // columns UPDATE) are revoked on purpose: every worker write is now a fenced function that checks the lease token in the same
  // transaction. The worker holds no table or column write at all.
  for (const role of ['app_web', 'media_service', 'monitor_worker', 'video_gateway']) add(role, 'USAGE', ['schema:public'])
  return lines.sort()
}

describe('P2-6 review round 1: grants and database fixes', () => {
  let orgId: string
  let person: TestUser
  let recorderId: string

  beforeAll(async () => {
    orgId = await createOrg()
    person = await createUser(orgId, 'user')
    recorderId = (await createSite(orgId, { host: '10.67.1.1', username: 'round1-login', secret: `R1-${randomUUID()}`, cameras: 0 })).recorderId
  })
  afterAll(() => cleanupOrg(orgId))

  it('M-1: the table and column grants of the four service roles are exactly the snapshot', async () => {
    const { data, error } = await call(adminClient(), 'service_role_grants')
    expect(error).toBeNull()
    const rows = (data ?? []) as { grantee: string; relation: string; privilege: string; column_name: string | null }[]
    const lines = rows.map((r) => `${r.grantee} ${r.privilege} ${r.relation}${r.column_name ? `(${r.column_name})` : ''}`).sort()
    expect(lines).toEqual(expectedGrants())
    expect(lines.filter((l) => l.startsWith('video_gateway'))).toEqual(['video_gateway USAGE schema:public'])
  })

  it('M-1: app_web updates the recorder clock and the profile columns the web code writes, and nothing else of those two tables', async () => {
    const web = serviceClient('app_web')
    const none = randomUUID() // filters that match no row: the privilege is checked, no row is touched
    expect((await web.from('recorders').update({ clock_offset_sec: 0, clock_offset_source: 'manual' } as never).eq('id', none)).error).toBeNull()
    expect((await web.from('profiles').update({ full_name: 'x', location_id: null, must_reset_password: false }).eq('id', none)).error).toBeNull()
    for (const change of [{ monitoring_enabled: false }, { username: 'x' }, { http_port: 81 }, { org_id: randomUUID() }]) {
      expect(code(await web.from('recorders').update(change as never).eq('id', recorderId)), JSON.stringify(change)).toBe('42501')
    }
    for (const change of [{ role: 'admin' }, { org_id: randomUUID() }, { is_active: false }, { email: 'x@example.test' }]) {
      expect(code(await web.from('profiles').update(change as never).eq('id', person.id)), JSON.stringify(change)).toBe('42501')
    }
  })

  it('M-2: media_service cannot use the rate limiter (only the web app counts, through app_web)', async () => {
    const media = serviceClient('media_service')
    expect(code(await call(media, 'rate_limit_hit', { p_key: 'x', p_limit: 1, p_window_sec: 60 }))).toBe('42501')
    expect(code(await call(media, 'rate_limit_state', { p_key: 'x', p_window_sec: 60 }))).toBe('42501')
    expect(code(await call(media, 'rate_limit_clear', { p_key: 'x' }))).toBe('42501')
    expect(code(await call(media, 'sign_in_gate', { p_key: 'sign_in:x0000000', p_ip_key: null, p_ip_limit: 10 }))).toBe('42501')
  })

  it('M-3: the web app lists the active organisations that still let the service key read NVR logins (the start-up check)', async () => {
    const web = serviceClient('app_web')
    const before = await call(web, 'security_unlocked_organizations')
    expect(before.error).toBeNull()
    expect(before.data as string[]).toContain(orgId) // no row in security_settings: unlocked
    try {
      expect((await call(adminClient(), 'security_settings_set_test', { p_org: orgId, p_service_role_credential_reads: false })).error).toBeNull()
      expect((await call(web, 'security_unlocked_organizations')).data as string[]).not.toContain(orgId)
    } finally {
      await call(adminClient(), 'security_settings_set_test', { p_org: orgId, p_service_role_credential_reads: true })
    }
    expect((await call(web, 'security_unlocked_organizations')).data as string[]).toContain(orgId)
    expect(code(await call(serviceClient('media_service'), 'security_unlocked_organizations'))).toBe('42501')
  })

  it('M-5: a GoTrue user can never be given a service role (PostgREST would switch to it)', async () => {
    const admin = adminClient()
    for (const role of ['app_web', 'media_service', 'monitor_worker', 'video_gateway', 'service_role', 'postgres']) {
      const r = await admin.auth.admin.updateUserById(person.id, { role })
      expect(r.error, role).not.toBeNull()
    }
    const ok = await admin.auth.admin.updateUserById(person.id, { role: 'authenticated' })
    expect(ok.error).toBeNull()
    expect((await call(admin, 'privilege_violations')).data).toEqual([])
  })

  it.skipIf(!dockerLogsReadable())('M-10: a refused NVR login read leaves a line in the database server log (role, recorder, purpose; never a value)', async () => {
    const since = Math.floor(Date.now() / 1000) - 2
    expect(code(await call(serviceClient('media_service'), 'recorder_credential_read', { p_recorder: recorderId, p_purpose: 'monitoring' }))).toBe('42501')
    expect(code(await call(serviceClient('monitor_worker'), 'recorder_credential_read', { p_recorder: recorderId, p_purpose: 'live' }))).toBe('42501')
    let log = ''
    for (let i = 0; i < 10 && !(log.includes('purpose monitoring') && log.includes('purpose live')); i++) {
      await new Promise((r) => setTimeout(r, 300))
      log = dbLogSince(since).split('\n').filter((l) => l.includes(recorderId)).join('\n')
    }
    expect(log).toMatch(/NVR login read refused.*role media_service.*purpose monitoring/)
    expect(log).toMatch(/NVR login read refused.*role monitor_worker.*purpose live/)
  })
})

const DB_CONTAINER = process.env.SUPABASE_DB_CONTAINER ?? 'supabase_db_cctv_hub'
function dbLogSince(sinceUnix: number): string {
  // The database writes its log to stderr, which `docker logs` passes on as its own stderr; only the lines naming the test recorder
  // are kept by the caller (never printed).
  const r = spawnSync('docker', ['logs', '--since', String(sinceUnix), DB_CONTAINER], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
  return `${r.stdout ?? ''}\n${r.stderr ?? ''}`
}
function dockerLogsReadable(): boolean {
  try {
    execFileSync('docker', ['logs', '--since', '1s', DB_CONTAINER], { stdio: 'ignore' })
    return true
  } catch {
    return false
  }
}
