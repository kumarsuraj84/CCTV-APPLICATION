import type { SupabaseClient } from '@supabase/supabase-js'
import type { Database } from '@/types/database'
import type { Result } from '@/lib/admin/types'
import type { Capability } from '@/lib/auth/capabilities'
import { logger } from '@/lib/observability/logger'

// Per-resource authorisation (P2-2). Every decision "may this person do this to that camera / location / asset" goes through here, and
// is made by the database's scope-specific functions as the person (their own signed-in client), so scope, expiry, revocation, status
// and MFA are evaluated by the database:
//   camerasFor   -> cameras_with_capability(cap, ids)        (a list: the subset the person may use)
//   cameraFor    -> has_capability_for(cap, 'camera', id)
//   locationFor  -> has_capability_for(cap, 'location', id)  (true only when the whole location is covered: organisation or location grant)
//   assetFor     -> has_capability_for(cap, 'asset', id)
//   coversSomeLocation -> capability_store_ids(cap)          (at least one whole location, or the organisation)
// Never the any-scope capability check, and never the reporting / diagnostic helpers (they skip MFA; tooling only).
// A check that fails is a plain failure, never "allowed". Only after an allowed answer may a service-role read (addresses, passwords)
// happen, and then scoped to the person's organisation.

type Client = SupabaseClient<Database>

export const MSG_ACCESS_CHECK_FAILED = 'Could not check your access. Please try again.'
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
/** PostgREST returns at most 1000 rows per answer (supabase/config.toml max_rows), so ids are asked in pieces of this size. */
const PIECE = 1000

const failed = (event: string, code: string | undefined): { ok: false; error: string } => {
  logger.error({ event, errorCode: code })
  return { ok: false, error: MSG_ACCESS_CHECK_FAILED }
}

/** Well-formed ids, lower case, without repeats, in the order given. */
export function cleanIds(ids: unknown): string[] {
  if (!Array.isArray(ids)) return []
  return [...new Set(ids.filter((v): v is string => typeof v === 'string' && UUID.test(v)).map((v) => v.toLowerCase()))]
}

/** The cameras among `ids` the person may use for `cap`, in the order asked for. */
export async function camerasFor(rls: Client, cap: Capability, ids: readonly string[]): Promise<Result<{ ids: string[] }>> {
  const wanted = cleanIds(ids)
  if (wanted.length === 0) return { ok: true, ids: [] }
  const allowed = new Set<string>()
  for (let i = 0; i < wanted.length; i += PIECE) {
    const { data, error } = await rls.rpc('cameras_with_capability', { p_cap: cap, p_ids: wanted.slice(i, i + PIECE) })
    if (error) return failed('access_check_failed', error.code)
    for (const c of (data as unknown as string[] | null) ?? []) allowed.add(String(c).toLowerCase())
  }
  return { ok: true, ids: wanted.filter((c) => allowed.has(c)) }
}

async function holdsFor(rls: Client, cap: Capability, kind: 'camera' | 'location' | 'asset', id: string): Promise<Result<{ allowed: boolean }>> {
  if (typeof id !== 'string' || !UUID.test(id)) return { ok: true, allowed: false }
  const { data, error } = await rls.rpc('has_capability_for', { p_cap: cap, p_kind: kind, p_id: id.toLowerCase() })
  if (error) return failed('access_check_failed', error.code)
  return { ok: true, allowed: data === true }
}

export const cameraFor = (rls: Client, cap: Capability, id: string) => holdsFor(rls, cap, 'camera', id)
export const locationFor = (rls: Client, cap: Capability, id: string) => holdsFor(rls, cap, 'location', id)
export const assetFor = (rls: Client, cap: Capability, id: string) => holdsFor(rls, cap, 'asset', id)

/** True when the capability covers at least one whole location (or the organisation). */
export async function coversSomeLocation(rls: Client, cap: Capability): Promise<Result<{ allowed: boolean }>> {
  const { data, error } = await rls.rpc('capability_store_ids', { p_cap: cap }).limit(1)
  if (error) return failed('access_check_failed', error.code)
  return { ok: true, allowed: Array.isArray(data) && data.length > 0 }
}
