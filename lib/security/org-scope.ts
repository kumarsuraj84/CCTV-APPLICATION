import type { SupabaseClient } from '@supabase/supabase-js'
import type { Database } from '@/types/database'

type Ref = { table: 'stores' | 'cameras' | 'devices' | 'profiles'; ids: string[] }

/**
 * Before the server (which bypasses row-level security) writes a foreign key, prove every referenced row belongs to the
 * caller's organisation. Throws when one does not.
 */
export async function assertRefsInOrg(admin: SupabaseClient<Database>, orgId: string, refs: Ref[]): Promise<void> {
  for (const { table, ids } of refs) {
    const unique = [...new Set(ids)]
    for (let i = 0; i < unique.length; i += 200) {
      const chunk = unique.slice(i, i + 200)
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const { data, error } = await (admin.from(table) as any).select('id').eq('org_id', orgId).in('id', chunk)
      if (error) throw new Error('Could not check references.')
      if ((data?.length ?? 0) !== chunk.length) throw new Error('A referenced record is outside this organisation.')
    }
  }
}
