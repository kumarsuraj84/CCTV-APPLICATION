'use server'

import { revalidatePath } from 'next/cache'
import { requireAdmin } from '@/lib/auth/profile'
import { discoverStoreCameras } from '@/lib/monitor/discovery'
import { createAdminClient } from '@/lib/supabase/admin'

export type DiscoverState = { message?: string; error?: string }

/** Asks the store's NVR which cameras it has and saves them. Administrators only; the store must belong to the caller's organisation. */
export async function discoverCamerasAction(storeId: string): Promise<DiscoverState> {
  const p = await requireAdmin()
  const res = await discoverStoreCameras(createAdminClient(), { id: p.id, orgId: p.org_id, role: p.role }, String(storeId))
  revalidatePath('/admin/stores')
  revalidatePath('/stores')
  if (!res.ok) return { error: res.error }
  return { message: `Found ${res.cameras} camera${res.cameras === 1 ? '' : 's'} (${res.created} new).` }
}
