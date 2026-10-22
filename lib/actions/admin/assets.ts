'use server'

// Server Actions of the asset inventory (P2-5c-1 brief item 4). Caller first (requireAdministration: signed in, active, password chosen,
// administrative role AND admin.inventory), then the service (role and capability again, organisation scope). Plain results only.
import { revalidatePath } from 'next/cache'
import { requireFreshAdministration } from '@/lib/auth/fresh'
import type { CurrentProfile } from '@/lib/auth/profile'
import { addDependency, addEndpoint, removeDependency, retireEndpoint, saveAsset } from '@/lib/inventory/assets'
import { submittedValues } from '@/lib/forms/submitted-values'
import { refusalFor } from '@/lib/rate-limit-shared'
import { createAdminClient } from '@/lib/supabase/admin'
import { createClient } from '@/lib/supabase/server'
import type { AdminActionState } from '@/lib/actions/admin/locations'

// P3-1 review I-3: every asset change goes through the one fresh-sign-in guard (requireFreshAdministration) first.
async function ctx(p: CurrentProfile) {
  // P2-6 (D-11): every administration action counts against the shared administration limit.
  const slow = await refusalFor('admin_action', p.id)
  return { clients: { admin: createAdminClient(), rls: await createClient() }, actor: { id: p.id, orgId: p.org_id, role: p.role }, slow }
}
const text = (f: FormData, k: string) => String(f.get(k) ?? '')
const refresh = () => {
  revalidatePath('/admin/assets', 'layout')
  revalidatePath('/devices')
}
const FIELDS = ['name', 'type', 'location_id', 'ip', 'tcp_port', 'serial', 'mac', 'vendor', 'model', 'firmware', 'role', 'owner', 'criticality', 'lifecycle_state', 'warranty_until', 'management_mode', 'notes', 'address_space_id']

export async function saveAssetAction(_prev: AdminActionState, f: FormData): Promise<AdminActionState> {
  const g = await requireFreshAdministration('admin.inventory')
  if (!g.ok) return { error: g.error }
  const { clients, actor, slow } = await ctx(g.profile)
  if (slow) return { error: slow }
  const res = await saveAsset(clients, actor, {
    id: text(f, 'id') || null, name: text(f, 'name'), type: text(f, 'type'), locationId: text(f, 'location_id') || null, ip: text(f, 'ip'), tcpPort: text(f, 'tcp_port'),
    serial: text(f, 'serial'), mac: text(f, 'mac'), vendor: text(f, 'vendor'), model: text(f, 'model'), firmware: text(f, 'firmware'), role: text(f, 'role'),
    owner: text(f, 'owner'), criticality: text(f, 'criticality'), lifecycleState: text(f, 'lifecycle_state'), warrantyUntil: text(f, 'warranty_until'),
    managementMode: text(f, 'management_mode'), notes: text(f, 'notes'), enabled: f.get('enabled') === 'on', addressSpaceId: text(f, 'address_space_id') || null,
  })
  refresh()
  return res.ok ? { ok: true, id: res.assetId, message: 'Asset saved.', ...(res.warning ? { warning: res.warning } : {}) } : { error: res.error, values: submittedValues(f, FIELDS, ['enabled']) }
}

export async function addDependencyAction(input: { childId: string; parentId: string; kind: string }): Promise<AdminActionState> {
  const g = await requireFreshAdministration('admin.inventory')
  if (!g.ok) return { error: g.error }
  const { clients, actor, slow } = await ctx(g.profile)
  if (slow) return { error: slow }
  const res = await addDependency(clients, actor, { childId: String(input?.childId ?? ''), parentId: String(input?.parentId ?? ''), kind: String(input?.kind ?? '') })
  refresh()
  return res.ok ? { ok: true, message: 'Dependency added.' } : { error: res.error }
}

export async function removeDependencyAction(dependencyId: string): Promise<AdminActionState> {
  const g = await requireFreshAdministration('admin.inventory')
  if (!g.ok) return { error: g.error }
  const { clients, actor, slow } = await ctx(g.profile)
  if (slow) return { error: slow }
  const res = await removeDependency(clients, actor, String(dependencyId))
  refresh()
  return res.ok ? { ok: true, message: 'Dependency removed.' } : { error: res.error }
}

export async function addEndpointAction(assetId: string, input: { spaceId: string; host: string; port: string; purpose: string }): Promise<AdminActionState> {
  const g = await requireFreshAdministration('admin.inventory')
  if (!g.ok) return { error: g.error }
  const { clients, actor, slow } = await ctx(g.profile)
  if (slow) return { error: slow }
  const res = await addEndpoint(clients, actor, String(assetId), { spaceId: String(input?.spaceId ?? ''), host: String(input?.host ?? ''), port: String(input?.port ?? ''), purpose: String(input?.purpose ?? '') })
  refresh()
  return res.ok ? { ok: true, message: 'Address added.' } : { error: res.error }
}

export async function retireEndpointAction(endpointId: string): Promise<AdminActionState> {
  const g = await requireFreshAdministration('admin.inventory')
  if (!g.ok) return { error: g.error }
  const { clients, actor, slow } = await ctx(g.profile)
  if (slow) return { error: slow }
  const res = await retireEndpoint(clients, actor, String(endpointId))
  refresh()
  return res.ok ? { ok: true, message: 'Address retired (kept in the history).' } : { error: res.error }
}
