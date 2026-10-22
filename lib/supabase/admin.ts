import type { SupabaseClient } from '@supabase/supabase-js'
import type { Database } from '@/types/database'
import { createAuthAdminClient, createServiceClient } from '@/lib/supabase/service-clients'

/**
 * The web app's server-side database client: bypasses row-level security, server only, never sent to the browser. Used after the
 * person's own check, always scoped to their organisation, for writes browsers must never make (users, grants, inventory, audit).
 * P2-6 (D-14): it acts as the web app's own database role `app_web` (key SUPABASE_APP_WEB_KEY), which can NOT read an NVR login, write
 * monitoring results, or call worker, gateway, test or diagnostic functions. NVR logins are read through createMediaClient
 * (lib/supabase/service-clients.ts). In development without the key it falls back to the service key with a warning.
 */
export function createAdminClient() {
  return createServiceClient('app_web')
}

/**
 * The web app's client for user administration: its database work as `app_web`, and only `auth.admin` (GoTrue's admin API, which
 * accepts nothing but the service key on this stack) through the service key.
 */
export function createUserAdminClient(): SupabaseClient<Database> {
  const db = createAdminClient()
  const gotrue = createAuthAdminClient()
  return new Proxy(db, {
    get(target, prop, receiver) {
      if (prop === 'auth') return gotrue.auth
      const value = Reflect.get(target, prop, receiver)
      return typeof value === 'function' ? value.bind(target) : value
    },
  })
}
