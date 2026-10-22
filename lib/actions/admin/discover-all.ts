'use server'

// Server Actions of "Find cameras for all locations" (P2-5c-2 brief item 2). The caller is checked first (requireAdministration:
// administrative role AND admin.inventory for the organisation), then the service asks again from the person's own summary. The run
// itself goes to Next's `after`, so the button gets its answer at once; the page polls the progress.
import { after } from 'next/server'
import { requireAdministration } from '@/lib/auth/profile'
import type { Result } from '@/lib/admin/types'
import { discoverAllStatus, startDiscoverAll, type RunView } from '@/lib/inventory/discover-all'
import { localGo2rtc } from '@/lib/streams/local-go2rtc'
import { createAdminClient } from '@/lib/supabase/admin'
import { createClient } from '@/lib/supabase/server'

export async function startDiscoverAllAction(): Promise<Result<{ runId: string; total: number }>> {
  const p = await requireAdministration('admin.inventory')
  return startDiscoverAll(
    { admin: createAdminClient(), rls: await createClient(), go2rtc: localGo2rtc() }, { id: p.id, orgId: p.org_id, role: p.role },
    { schedule: (work) => after(work) },
  )
}

export async function discoverAllStatusAction(runId: string): Promise<Result<{ run: RunView }>> {
  const p = await requireAdministration('admin.inventory')
  return discoverAllStatus({ admin: createAdminClient(), rls: await createClient() }, { id: p.id, orgId: p.org_id, role: p.role }, String(runId))
}
