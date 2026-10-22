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

export function adminClient(): SupabaseClient<Database> {
  assertLocalStack()
  return createClient<Database>(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, opts)
}

export async function createOrg(): Promise<string> {
  const tag = randomUUID()
  const { data, error } = await adminClient().from('organizations').insert({ name: `test-${tag}`, slug: `test-${tag}` }).select('id').single()
  if (error || !data) throw new Error(`createOrg failed: ${error?.message}`)
  return data.id
}

export async function createUser(orgId: string, role: Role, o: { storeId?: string | null; mustReset?: boolean } = {}): Promise<TestUser> {
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
      store_id: o.storeId ?? null,
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
export type GrantScope = { kind: 'organization' } | { kind: 'location' | 'camera' | 'asset'; id: string }
export const ORG_SCOPE: GrantScope = { kind: 'organization' }
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

// Child tables first. Add new organisation-scoped tables here.
// access_grants and access_migration_report are not listed: nobody may delete them (append-only history). Grants go with their
// person (profiles cascade) and report rows with their organisation (organizations cascade).
export const ORG_TABLES_IN_DELETE_ORDER: string[] = [
  'camera_group_items',
  'camera_groups',
  'outages',
  'check_state',
  'admin_audit_log',
  // Retired grant tables of the old model (P2-1): read by nothing, kept one release for the migration report and its test.
  'user_camera_access',
  'user_zone_access',
  'user_store_access',
  'devices',
  'cameras',
  'stores',
]

export async function cleanupOrg(orgId: string | undefined): Promise<void> {
  if (!orgId) return // a failed setup must not hide its own error behind a cleanup error
  const admin = adminClient()
  const problems: string[] = []
  const note = (what: string, error: { message: string } | null) => {
    if (error) problems.push(`${what}: ${error.message}`)
  }
  // Remove the NVR passwords from the vault before their stores disappear.
  const { data: stores, error: sErr } = await admin.from('stores').select('id').eq('org_id', orgId)
  note('list stores', sErr)
  for (const s of stores ?? []) note('vault', (await admin.rpc('nvr_delete_credential', { p_store: s.id })).error)
  for (const table of ORG_TABLES_IN_DELETE_ORDER) {
    // @ts-expect-error -- table names here are plain strings on purpose
    note(table, (await admin.from(table).delete().eq('org_id', orgId)).error)
  }
  const { data: people, error: pErr } = await admin.from('profiles').select('id').eq('org_id', orgId)
  note('list profiles', pErr)
  for (const p of people ?? []) note('auth user', (await admin.auth.admin.deleteUser(p.id)).error)
  note('profiles', (await admin.from('profiles').delete().eq('org_id', orgId)).error)
  note('organization', (await admin.from('organizations').delete().eq('id', orgId)).error)
  if (problems.length) throw new Error(`cleanupOrg(${orgId}) left rows behind: ${problems.join('; ')}`)
}
