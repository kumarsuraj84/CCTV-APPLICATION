'use server'

// Server Actions of "Find cameras for all locations" (P2-5c-2 brief item 2). The caller is checked first (requireAdministration:
// administrative role AND admin.inventory for the organisation), then the service asks again from the person's own summary. The run
// itself goes to Next's `after`, so the button gets its answer at once; the page polls the progress.
import { after } from 'next/server'
import { requireAdministration } from '@/lib/auth/profile'
import type { Result } from '@/lib/admin/types'
import { discoverAllStatus, startDiscoverAll, stopDiscoverAll, type RunView } from '@/lib/inventory/discover-all'
import type { InventoryClients } from '@/lib/inventory/admin-gate'
import { adminRefusalFor } from '@/lib/rate-limit-shared'
import { localGo2rtc } from '@/lib/streams/local-go2rtc'
import { createAdminClient } from '@/lib/supabase/admin'
import { createClient } from '@/lib/supabase/server'
import { createMediaClient } from '@/lib/supabase/service-clients'

export async function startDiscoverAllAction(): Promise<Result<{ runId: string; total: number }>> {
  const p = await requireAdministration('admin.inventory')
  // P2-6 (D-11): three starts per administrator in ten minutes, shared by every app instance (plus the overall administration count).
  const slow = await adminRefusalFor('discover_all', p.id)
  if (slow) return { ok: false, error: slow }
  const clients: InventoryClients = { admin: createAdminClient(), rls: await createClient(), go2rtc: localGo2rtc() }
  // P2-6 (D-14): NVR logins are read through the media path's client (the web app's own role cannot), made when the run needs it.
  Object.defineProperty(clients, 'credentials', { enumerable: false, get: () => createMediaClient() })
  return startDiscoverAll(clients, { id: p.id, orgId: p.org_id, role: p.role }, { schedule: (work) => after(work) })
}

/** Review B-M10: "Stop" — no further NVR is asked. */
export async function stopDiscoverAllAction(runId: string): Promise<Result<object>> {
  const p = await requireAdministration('admin.inventory')
  return stopDiscoverAll({ admin: createAdminClient(), rls: await createClient() }, { id: p.id, orgId: p.org_id, role: p.role }, String(runId))
}

export async function discoverAllStatusAction(runId: string): Promise<Result<{ run: RunView }>> {
  const p = await requireAdministration('admin.inventory')
  return discoverAllStatus({ admin: createAdminClient(), rls: await createClient() }, { id: p.id, orgId: p.org_id, role: p.role }, String(runId))
}
