'use server'

import { revalidatePath } from 'next/cache'
import { requireAdministration } from '@/lib/auth/profile'
import { discoverStoreCameras } from '@/lib/monitor/discovery'
import { createAdminClient } from '@/lib/supabase/admin'
import { createClient } from '@/lib/supabase/server'

export type DiscoverState = { message?: string; error?: string }

/**
 * Asks the store's NVR which cameras it has and saves them. An administrative role AND admin.inventory (P2-2); the service checks the
 * store against admin.inventory again in the database, as the person, before it reads the NVR login.
 */
export async function discoverCamerasAction(storeId: string): Promise<DiscoverState> {
  const p = await requireAdministration('admin.inventory')
  const res = await discoverStoreCameras({ admin: createAdminClient(), rls: await createClient() }, { id: p.id, orgId: p.org_id, role: p.role }, String(storeId))
  revalidatePath('/admin/stores')
  revalidatePath('/stores')
  if (!res.ok) return { error: res.error }
  return { message: `Found ${res.cameras} camera${res.cameras === 1 ? '' : 's'} (${res.created} new).` }
}
