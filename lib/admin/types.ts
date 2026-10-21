import type { SupabaseClient } from '@supabase/supabase-js'
import type { Database } from '@/types/database'
import type { Role } from '@/lib/admin/roles'

export type AdminClient = SupabaseClient<Database>
export type Actor = { id: string; orgId: string; role: Role }
export type Result<T> = ({ ok: true } & T) | { ok: false; error: string }
