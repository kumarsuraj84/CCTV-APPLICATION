'use server'

import { revalidatePath } from 'next/cache'
import { requireAdministration } from '@/lib/auth/profile'
import { discoverStoreCameras } from '@/lib/monitor/discovery'
import { discoverySummary } from '@/lib/monitor/discovery-summary'
import { realProbes } from '@/lib/monitor/probes'
import { localGo2rtc } from '@/lib/streams/local-go2rtc'
import { createAdminClient } from '@/lib/supabase/admin'
import { createClient } from '@/lib/supabase/server'

export type DiscoverState = { message?: string; error?: string; details?: string[] }

/**
 * Asks every NVR of the store which cameras it has and saves them (P2-5b: per recorder; a switched-off NVR is skipped without any
 * contact). An administrative role AND admin.inventory (P2-2); the service checks the store against admin.inventory again in the
 * database, as the person, before it reads any NVR login.
 */
export async function discoverCamerasAction(storeId: string): Promise<DiscoverState> {
  const p = await requireAdministration('admin.inventory')
  const res = await discoverStoreCameras({ admin: createAdminClient(), rls: await createClient() }, { id: p.id, orgId: p.org_id, role: p.role }, String(storeId), {
    nvr: realProbes.nvr, go2rtc: localGo2rtc(),
  })
  revalidatePath('/admin/stores')
  revalidatePath('/stores')
  if (!res.ok) return { error: res.error }
  return discoverySummary(res)
}
