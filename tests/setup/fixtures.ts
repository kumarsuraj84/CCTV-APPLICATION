import { randomBytes, randomUUID } from 'node:crypto'
import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import type { Database } from '@/types/database'
import { ADMIN_BASELINE } from '../../scripts/lib/demo'

export type Role = Database['public']['Enums']['user_role']
export type TestUser = { id: string; email: string; password: string; client: SupabaseClient<Database> }

// Isolation gate: integration tests may only touch the local Supabase stack, never anything else.
export function assertLocalStack(): void {
  const u = new URL(process.env.NEXT_PUBLIC_SUPABASE_URL ?? 'http://invalid.invalid')
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(u.hostname)
  if (!local || u.port !== '55321') {
    throw new Error('Isolation gate: integration tests only run against the local Supabase stack on port 55321.')
  }
}

const opts = { auth: { persistSession: false, autoRefreshToken: false } }

// P2-7 review round 1 (M-5): worker_state and monitor_gaps refuse direct writes by the service key (only the worker's fenced functions
// write them), so that an old worker on the development key is refused cleanly. Test fixtures still set and restore those rows; they
// say so with this header (migration 20261021000039). Not a security boundary: the service key is trusted with everything else.
const fixtureOpts = { ...opts, global: { headers: { 'x-drishti-test-fixture': 'on' } } }

export function adminClient(): SupabaseClient<Database> {
  assertLocalStack()
  return createClient<Database>(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, fixtureOpts)
}

export async function createOrg(): Promise<string> {
  const tag = randomUUID()
  const { data, error } = await adminClient().from('organizations').insert({ name: `test-${tag}`, slug: `test-${tag}` }).select('id').single()
  if (error || !data) throw new Error(`createOrg failed: ${error?.message}`)
  return data.id
}

export async function createUser(orgId: string, role: Role, o: { storeId?: string | null; locationId?: string | null; mustReset?: boolean } = {}): Promise<TestUser> {
  const admin = adminClient()
  const email = `${randomUUID()}@example.test`
  const password = randomBytes(12).toString('base64url') + 'aA1!'
  const { data, error } = await admin.auth.admin.createUser({ email, password, email_confirm: true })
  if (error || !data.user) throw new Error(`createUser failed: ${error?.message}`)
  try {
    const { error: pErr } = await admin.from('profiles').insert({
      id: data.user.id,
      org_id: orgId,
      email,
      full_name: 'Test User',
      role,
      must_reset_password: o.mustReset ?? false,
      // P2-5a: profiles.store_id was renamed location_id (the home location: information only, grants nothing).
      location_id: o.locationId ?? o.storeId ?? null,
    })
    if (pErr) throw new Error(`profile insert failed: ${pErr.message}`)
    const client = createClient<Database>(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!, opts)
    const { error: sErr } = await client.auth.signInWithPassword({ email, password })
    if (sErr) throw new Error(`sign-in failed: ${sErr.message}`)
    return { id: data.user.id, email, password, client }
  } catch (e) {
    await admin.auth.admin.deleteUser(data.user.id)
    throw e
  }
}

// ── Capability grants (P2-1, directive AC-1/AC-5) ────────────────────────────
// Access is only ever given by explicit grants: a capability at a scope. No role gives data access by itself.
// P2-5a (ruling C-1): scope kinds organization, region, cluster, location, recorder, camera, asset.
export type GrantScope = { kind: 'organization' } | { kind: 'region' | 'cluster' | 'location' | 'recorder' | 'camera' | 'asset'; id: string }
export const ORG_SCOPE: GrantScope = { kind: 'organization' }
export const atRegion = (id: string): GrantScope => ({ kind: 'region', id })
export const atCluster = (id: string): GrantScope => ({ kind: 'cluster', id })
export const atRecorder = (id: string): GrantScope => ({ kind: 'recorder', id })
export const atLocation = (id: string): GrantScope => ({ kind: 'location', id })
export const atCamera = (id: string): GrantScope => ({ kind: 'camera', id })
export const atAsset = (id: string): GrantScope => ({ kind: 'asset', id })
/** Live video and recordings: what a store or camera grant meant before the capability model (D-2). */
export const CCTV_VIEW = ['cctv.live', 'cctv.playback'] as const
/** What a manager used to read across the organisation (D-2a, migrated:manager): now only as explicit grants. */
export const READ_EVERYTHING = ['cctv.live', 'cctv.playback', 'it.inventory.view', 'it.monitoring.view'] as const
/** What an administrator gets as organisation-wide grants (the migration's migrated:admin set; the dev admin and the demo get it too). */
export const ADMINISTRATOR_SET: readonly string[] = ADMIN_BASELINE

/**
 * Grants every capability at every scope given (one grant row each) through the server-only grant_access function.
 * Returns the ids of the grants, in the order capability × scope. An identical active grant is not added twice.
 */
export async function grant(
  orgId: string,
  userId: string,
  capabilities: string | readonly string[],
  scopes: GrantScope | readonly GrantScope[] = ORG_SCOPE,
  o: { validFrom?: string; validUntil?: string } = {},
): Promise<string[]> {
  const caps: readonly string[] = typeof capabilities === 'string' ? [capabilities] : capabilities
  const list: readonly GrantScope[] = 'kind' in scopes ? [scopes as GrantScope] : (scopes as readonly GrantScope[])
  const p_grants = caps.flatMap((capability) =>
    list.map((s) => ({ capability, scope_kind: s.kind, scope_id: s.kind === 'organization' ? null : s.id, valid_from: o.validFrom, valid_until: o.validUntil })),
  )
  const { data, error } = await adminClient().rpc('grant_access', { p_org: orgId, p_user: userId, p_grants, p_reason: 'test fixture' })
  if (error) throw new Error(`grant failed: ${error.message}`)
  return (data as { grant_ids: string[] }).grant_ids
}

// ── Locations, recorders, cameras and assets (P2-5a, ruling C-1: Organization → Region → Cluster → Location → NVR → Camera) ──
// Every helper writes through the service role, like the admin screens will. Codes are random so tests never collide.
const code = (prefix: string) => `${prefix}${randomUUID().slice(0, 6).toUpperCase()}`
/** A random private address (addresses are unique within an address space, so fixtures never pick the same one twice by chance). */
const randomHost = (first: string) => {
  const b = randomBytes(3)
  return `${first}.${b[0]}.${b[1]}.${1 + (b[2] % 254)}`
}
const must = <T>(what: string, r: { data: T; error: { message: string } | null }): NonNullable<T> => {
  if (r.error || r.data === null || r.data === undefined) throw new Error(`${what} failed: ${r.error?.message ?? 'no row'}`)
  return r.data as NonNullable<T>
}

export async function createRegion(orgId: string, o: { code?: string; name?: string } = {}): Promise<string> {
  const c = o.code ?? code('R')
  return must('createRegion', await adminClient().from('regions').insert({ org_id: orgId, code: c, name: o.name ?? `Region ${c}` }).select('id').single()).id
}

export async function createCluster(orgId: string, regionId: string | null, o: { code?: string; name?: string } = {}): Promise<string> {
  const c = o.code ?? code('C')
  return must('createCluster', await adminClient().from('clusters').insert({ org_id: orgId, region_id: regionId, code: c, name: o.name ?? `Cluster ${c}` }).select('id').single()).id
}

export type LocationKind = 'store' | 'head_office' | 'dc' | 'warehouse' | 'other'
/**
 * A location of any kind, without any recorder (a head office, a DC; add NVRs with createRecorder, or use createSite). P2-5b: a
 * location row holds no NVR data any more (the contract migration dropped the legacy columns and the seam).
 */
export async function createLocation(orgId: string, o: {
  code?: string; name?: string; kind?: LocationKind; clusterId?: string | null; zone?: string | null; state?: string | null; isActive?: boolean
} = {}): Promise<string> {
  const c = o.code ?? code('L')
  return must('createLocation', await adminClient().from('locations').insert({
    org_id: orgId, code: c, name: o.name ?? `Location ${c}`, kind: o.kind ?? 'store', cluster_id: o.clusterId ?? null, zone: o.zone ?? null,
    state: o.state ?? null, is_active: o.isActive ?? true,
  }).select('id').single()).id
}

/**
 * A recorder (NVR) at a location: an asset of type nvr plus its recorders row (same id). Optionally its login password in the vault, a
 * clock offset (seconds, ruling R13 direction), the number of cameras it should have, and monitoring switched off (with a reason).
 */
export async function createRecorder(orgId: string, locationId: string, o: {
  host?: string; httpPort?: number; rtspPort?: number; username?: string; secret?: string; name?: string; addressSpaceId?: string
  clockOffsetSec?: number | null; expectedChannels?: number; monitoringOff?: string
} = {}): Promise<string> {
  const admin = adminClient()
  const host = o.host ?? randomHost('10')
  let asset: string
  if (o.addressSpaceId) {
    // A chosen address space: written directly (the tests of address spaces need that).
    asset = must('createRecorder(asset)', await admin.from('assets').insert({
      org_id: orgId, location_id: locationId, type: 'nvr', name: o.name ?? 'NVR', ip: host, tcp_port: o.httpPort ?? 80, address_space_id: o.addressSpaceId,
    }).select('id').single()).id
    must('createRecorder', await admin.from('recorders').insert({
      id: asset, org_id: orgId, location_id: locationId, http_port: o.httpPort ?? 80, rtsp_port: o.rtspPort ?? 554, username: o.username ?? 'viewer',
    }).select('id').single())
  } else {
    // The application's own way (P2-5b recorder_save): an address already used elsewhere in the organisation moves the recorder into
    // its location's own address space (D5-8), so two test locations may point at the same fake NVR on loopback.
    asset = must('createRecorder', await admin.rpc('recorder_save', {
      p_org: orgId, p_location: locationId, p_recorder: null as unknown as string, p_host: host, p_http_port: o.httpPort ?? 80, p_rtsp_port: o.rtspPort ?? 554,
      p_username: o.username ?? 'viewer', p_expected_channels: o.expectedChannels ?? 0, p_name: o.name ?? 'NVR',
    })) as string
  }
  const extra = {
    ...(o.clockOffsetSec != null ? { clock_offset_sec: o.clockOffsetSec, clock_offset_source: 'manual' } : {}),
    ...(o.monitoringOff ? { monitoring_enabled: false, monitoring_disabled_reason: o.monitoringOff, monitoring_disabled_at: new Date().toISOString() } : {}),
  }
  if (Object.keys(extra).length > 0) must('createRecorder(settings)', await admin.from('recorders').update(extra).eq('id', asset).select('id').single())
  if (o.secret) {
    const { error } = await admin.rpc('recorder_store_credential', { p_recorder: asset, p_secret: o.secret })
    if (error) throw new Error(`createRecorder(secret) failed: ${error.message}`)
  }
  return asset
}

/**
 * A camera at a location, mapped to `recorderId` on `channel`. Without a recorder the database maps it only when the location has
 * exactly one NVR (P2-5b); `recorderId: null` with several NVRs leaves it unmapped (never probed, never streamed).
 */
export async function createCamera(orgId: string, o: { locationId: string; recorderId?: string | null; channel: number; name?: string; isActive?: boolean; cameraIp?: string | null }): Promise<string> {
  return must('createCamera', await adminClient().from('cameras').insert({
    org_id: orgId, location_id: o.locationId, recorder_id: o.recorderId ?? null, channel: o.channel, name: o.name ?? `Camera ${o.channel}`, is_active: o.isActive ?? true,
    camera_ip: o.cameraIp ?? null,
  }).select('id').single()).id
}

/**
 * The usual test site (P2-5b, replaces the old store row with NVR columns): a location with ONE recorder and `cameras` cameras on
 * channels 1..n of that recorder. Returns the ids. The recorder's address, ports, login and password are its own.
 */
export async function createSite(orgId: string, o: {
  code?: string; name?: string; isActive?: boolean; clusterId?: string | null; kind?: LocationKind; recorderName?: string
  host?: string; httpPort?: number; rtspPort?: number; username?: string; secret?: string; cameras?: number; clockOffsetSec?: number | null; monitoringOff?: string
} = {}): Promise<{ locationId: string; recorderId: string; cameraIds: string[] }> {
  const locationId = await createLocation(orgId, { code: o.code, name: o.name, isActive: o.isActive, clusterId: o.clusterId, kind: o.kind })
  const recorderId = await createRecorder(orgId, locationId, {
    host: o.host, httpPort: o.httpPort, rtspPort: o.rtspPort, username: o.username, secret: o.secret, clockOffsetSec: o.clockOffsetSec, monitoringOff: o.monitoringOff,
    name: o.recorderName,
  })
  const cameraIds: string[] = []
  for (let ch = 1; ch <= (o.cameras ?? 0); ch++) cameraIds.push(await createCamera(orgId, { locationId, recorderId, channel: ch }))
  return { locationId, recorderId, cameraIds }
}

/**
 * P2-6 (review M-3 of P2-5b made required): every camera result given to monitor_apply_results must name the recorder that produced
 * it, as the worker does. Tests that write camera results by hand pass them through this: a camera result without `recorder` gets the
 * camera's CURRENT recorder (its active mapping), exactly what the worker would send. Other results are returned unchanged.
 */
export async function withRecorders<T extends { type: string; id: string; recorder?: string }>(results: T[]): Promise<T[]> {
  const ids = [...new Set(results.filter((r) => r.type === 'camera' && r.recorder === undefined).map((r) => r.id))]
  if (ids.length === 0) return results
  const { data, error } = await adminClient().from('cameras').select('id, recorder_id').in('id', ids)
  if (error) throw new Error(`withRecorders failed: ${error.message}`)
  const of = new Map((data ?? []).map((c) => [c.id, c.recorder_id]))
  return results.map((r) => (r.type === 'camera' && r.recorder === undefined && of.get(r.id) ? { ...r, recorder: of.get(r.id)! } : r))
}

/** Moves a camera to another recorder/channel (closes the active mapping, opens a new one). Returns the new mapping id. */
export async function mapCamera(orgId: string, cameraId: string, recorderId: string, channel: number, at?: string): Promise<string> {
  const { data, error } = await adminClient().rpc('camera_remap', { p_org: orgId, p_camera: cameraId, p_recorder: recorderId, p_channel: channel, ...(at ? { p_at: at } : {}) })
  if (error) throw new Error(`mapCamera failed: ${error.message}`)
  return data as string
}

export async function createAsset(orgId: string, o: { locationId: string | null; type?: string; name?: string; ip?: string | null; port?: number | null; addressSpaceId?: string | null }): Promise<string> {
  return must('createAsset', await adminClient().from('assets').insert({
    org_id: orgId, location_id: o.locationId, type: (o.type ?? 'server') as Database['public']['Enums']['device_type'], name: o.name ?? 'Asset',
    ip: o.ip === undefined ? randomHost('172') : o.ip, tcp_port: o.port ?? null, address_space_id: o.addressSpaceId ?? null,
  }).select('id').single()).id
}

/**
 * The location's primary recorder: the one the 5a data migration made for it (`migrated_from_location_id` = the location), else the
 * first one created. The same rule as `recorder_primary_of` in the database (the legacy single-NVR form and CSV use it).
 */
export async function primaryRecorderOf(locationId: string): Promise<string> {
  const { data, error } = await adminClient().rpc('recorder_primary_of', { p_location: locationId })
  if (error) throw new Error(`primaryRecorderOf failed: ${error.message}`)
  if (!data) throw new Error('primaryRecorderOf: the location has no recorder')
  return data as string
}

// Child tables first. Add new organisation-scoped tables here.
// access_grants and access_migration_report are not listed: nobody may delete them (append-only history). Grants go with their
// person (profiles cascade) and report rows with their organisation (organizations cascade).
// P2-5a: locations, recorders, cameras, assets and their history can no longer be deleted (archive instead, SQLSTATE DR003); a test
// or demo organisation is emptied by the one purge function allowed to (inventory_purge_test_org, which also removes vault secrets).
// P5.4 (migration 20261021000041): admin_audit_log is append-only; a test or demo organisation's audit rows are removed by
// audit_purge_test_org (cleanupOrg below), not by a delete of the table.
export const ORG_TABLES_IN_DELETE_ORDER: string[] = [
  'camera_group_items',
  'camera_groups',
  // Retired grant tables of the old model (P2-1): read by nothing, kept one release for the migration report and its test.
  'user_camera_access',
  'user_zone_access',
  'user_store_access',
]

/** Only organisations made by the tests (slug `test-…`) or the demo organisation may ever be emptied (review M12). */
export const CLEANABLE_SLUG = /^(test-.+|demo-sample-data)$/

export async function cleanupOrg(orgId: string | undefined): Promise<void> {
  if (!orgId) return // a failed setup must not hide its own error behind a cleanup error
  const admin = adminClient()
  // Review M12: refuse BEFORE deleting anything (the first deletes below are not guarded by the database).
  const { data: org, error: orgErr } = await admin.from('organizations').select('slug').eq('id', orgId).maybeSingle()
  if (orgErr) throw new Error(`cleanupOrg(${orgId}): could not read the organisation: ${orgErr.message}`)
  if (!org) return // already gone
  if (!CLEANABLE_SLUG.test(org.slug)) throw new Error(`cleanupOrg(${orgId}) refused: "${org.slug}" is not a test or demo organisation`)
  const problems: string[] = []
  const note = (what: string, error: { message: string } | null) => {
    if (error) problems.push(`${what}: ${error.message}`)
  }
  for (const table of ORG_TABLES_IN_DELETE_ORDER) {
    // @ts-expect-error -- table names here are plain strings on purpose
    note(table, (await admin.from(table).delete().eq('org_id', orgId)).error)
  }
  // P5.4: the audit rows through the one clean-up function allowed to delete them (a database without migration 0041 — rolled back —
  // has no such function and still allows the plain delete).
  const purged = await admin.rpc('audit_purge_test_org' as never, { p_org: orgId } as never)
  if (purged.error?.code === 'PGRST202') note('admin_audit_log', (await admin.from('admin_audit_log').delete().eq('org_id', orgId)).error)
  else note('admin_audit_log (purge)', purged.error)
  // Monitoring history, mappings, cameras, recorders (with their vault secrets), assets, locations, clusters, regions.
  note('inventory (purge)', (await admin.rpc('inventory_purge_test_org', { p_org: orgId })).error)
  const { data: people, error: pErr } = await admin.from('profiles').select('id').eq('org_id', orgId)
  note('list profiles', pErr)
  // P2-3 review I-1: the last active super administrator of an organisation cannot be deleted; the clean-up of a test or demo
  // organisation removes its people through the one server function allowed to (it refuses every other organisation).
  if ((people ?? []).length > 0) note('profiles (teardown)', (await admin.rpc('access_teardown_test_org_people', { p_org: orgId })).error)
  for (const p of people ?? []) note('auth user', (await admin.auth.admin.deleteUser(p.id)).error)
  note('profiles', (await admin.from('profiles').delete().eq('org_id', orgId)).error)
  note('organization', (await admin.from('organizations').delete().eq('id', orgId)).error)
  if (problems.length) throw new Error(`cleanupOrg(${orgId}) left rows behind: ${problems.join('; ')}`)
}
