import { createClient } from '@supabase/supabase-js'
import type { Database } from '@/types/database'
import { resilientFetch } from '@/lib/supabase/resilient-fetch'

/**
 * Service-role client: bypasses row-level security. Server only, never sent to the browser.
 * Used for writes that browsers must never make (users, grants, inventory, audit, Vault).
 */
export function createAdminClient() {
  return createClient<Database>(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, {
    auth: { autoRefreshToken: false, persistSession: false },
    global: { fetch: resilientFetch },
  })
}
