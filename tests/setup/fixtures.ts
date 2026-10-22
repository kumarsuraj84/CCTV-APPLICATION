import { randomBytes, randomUUID } from 'node:crypto'
import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import type { Database } from '@/types/database'

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

// Child tables first. Add new organisation-scoped tables here.
export const ORG_TABLES_IN_DELETE_ORDER: string[] = [
  'camera_group_items',
  'camera_groups',
  'outages',
  'check_state',
  'admin_audit_log',
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
