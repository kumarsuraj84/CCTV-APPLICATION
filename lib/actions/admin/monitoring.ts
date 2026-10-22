'use server'

import { revalidatePath } from 'next/cache'
import { requireAdministration } from '@/lib/auth/profile'
import { discoverStoreCameras } from '@/lib/monitor/discovery'
import { createAdminClient } from '@/lib/supabase/admin'
import { createClient } from '@/lib/supabase/server'

export type DiscoverState = { message?: string; error?: string }

/**
 * Asks every NVR of the store which cameras it has and saves them (P2-5b: per recorder; a switched-off NVR is skipped without any
 * contact). An administrative role AND admin.inventory (P2-2); the service checks the store against admin.inventory again in the
 * database, as the person, before it reads any NVR login.
 */
export async function discoverCamerasAction(storeId: string): Promise<DiscoverState> {
  const p = await requireAdministration('admin.inventory')
  const res = await discoverStoreCameras({ admin: createAdminClient(), rls: await createClient() }, { id: p.id, orgId: p.org_id, role: p.role }, String(storeId))
  revalidatePath('/admin/stores')
  revalidatePath('/stores')
  if (!res.ok) return { error: res.error }
  const toCheck = res.recorders.reduce((n, r) => n + (r.ok ? r.result.reconciliation.length : 0), 0)
  const failed = res.recorders.filter((r) => !r.ok).length
  const parts = [`Found ${res.cameras} camera${res.cameras === 1 ? '' : 's'} (${res.created} new).`]
  if (toCheck > 0) parts.push(`${toCheck} ${toCheck === 1 ? 'camera needs' : 'cameras need'} a look: ${toCheck === 1 ? 'it' : 'they'} may have moved to another NVR.`)
  if (failed > 0) parts.push(`${failed} ${failed === 1 ? 'NVR' : 'NVRs'} could not be asked.`)
  return { message: parts.join(' ') }
}
