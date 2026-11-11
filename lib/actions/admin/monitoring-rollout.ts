'use server'

// Final fix X (release 1 review C I-4; rulings NB-3, NB-4): the monitoring rollout (switch monitoring on or off for a whole region,
// cluster, location or the organisation) and "Try again" on an NVR whose login stands refused. Both change what the system sends to real
// NVRs, so both go through the one fresh-sign-in guard first (P3-1; tests/unit/fresh-auth-guard.test.ts lists them as must-be-guarded),
// then the service checks the administrative role and admin.inventory for the whole organisation again, and the database a third time.
import { revalidatePath } from 'next/cache'
import { requireFreshAdministration } from '@/lib/auth/fresh'
import type { InventoryClients } from '@/lib/inventory/admin-gate'
import { setMonitoringRollout, tryNvrLoginAgain } from '@/lib/inventory/monitoring-rollout'
import { refusalFor } from '@/lib/rate-limit-shared'
import { createAdminClient } from '@/lib/supabase/admin'
import { createClient } from '@/lib/supabase/server'

export type MonitoringActionState = { ok?: boolean; error?: string; message?: string }

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`

export async function setMonitoringRolloutAction(input: { scope: string; scopeId?: string | null; enabled: boolean; reason: string }): Promise<MonitoringActionState> {
  const g = await requireFreshAdministration('admin.inventory')
  if (!g.ok) return { ok: false, error: g.error }
  const busy = await refusalFor('admin_action', g.profile.id)
  if (busy) return { ok: false, error: busy }
  const clients: InventoryClients = { admin: createAdminClient(), rls: await createClient() }
  const res = await setMonitoringRollout(clients, { id: g.profile.id, orgId: g.profile.org_id, role: g.profile.role }, input)
  if (!res.ok) return { ok: false, error: res.error }
  for (const p of ['/admin/monitoring', '/admin/monitoring/rollout', '/admin/locations', '/locations']) revalidatePath(p, 'layout')
  const what = input?.enabled ? 'switched on' : 'switched off'
  return {
    ok: true,
    message: res.changed === 0
      ? `Nothing changed: all ${plural(res.matched, 'NVR', 'NVRs')} there were already ${what}.`
      : `Monitoring ${what} for ${plural(res.changed, 'NVR', 'NVRs')}${res.matched > res.changed ? ` (${res.matched - res.changed} already were)` : ''}.${input?.enabled ? ' NVRs never checked before are contacted a few at a time.' : ' Nothing contacts them now.'}`,
  }
}

export async function tryNvrLoginAgainAction(recorderId: string): Promise<MonitoringActionState> {
  const g = await requireFreshAdministration('admin.inventory')
  if (!g.ok) return { ok: false, error: g.error }
  const busy = await refusalFor('admin_action', g.profile.id)
  if (busy) return { ok: false, error: busy }
  const clients: InventoryClients = { admin: createAdminClient(), rls: await createClient() }
  const res = await tryNvrLoginAgain(clients, { id: g.profile.id, orgId: g.profile.org_id, role: g.profile.role }, String(recorderId))
  if (!res.ok) return { ok: false, error: res.error }
  revalidatePath('/admin/monitoring', 'layout')
  return { ok: true, message: 'The NVR will be tried once more at the next check. If its login is still refused, it is left alone again.' }
}
