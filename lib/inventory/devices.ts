import type { Actor, AdminClient, Result } from '@/lib/admin/types'
import { addAudit } from '@/lib/admin/audit'
import { isAdminRole } from '@/lib/admin/roles'
import { deviceSchema } from '@/lib/inventory/schemas'
import { sanitizeError } from '@/lib/observability/sanitize-error'
import { assertRefsInOrg } from '@/lib/security/org-scope'

const DENIED = 'Only administrators can change devices.'

async function checked(admin: AdminClient, actor: Actor, input: unknown) {
  const parsed = deviceSchema.safeParse(input)
  if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? 'Check the form and try again.' } as const
  const v = parsed.data
  if (v.store_id) {
    try {
      await assertRefsInOrg(admin, actor.orgId, [{ table: 'locations', ids: [v.store_id] }])
    } catch {
      return { error: 'That store was not found.' } as const
    }
  }
  return { value: v } as const
}

export async function createDevice(admin: AdminClient, actor: Actor, input: unknown): Promise<Result<{ deviceId: string }>> {
  if (!isAdminRole(actor.role)) return { ok: false, error: DENIED }
  const c = await checked(admin, actor, input)
  if (!c.value) return { ok: false, error: c.error }
  const v = c.value
  const { data, error } = await admin.from('assets').insert({
    org_id: actor.orgId, location_id: v.store_id ?? null, type: v.type, name: v.name, ip: v.ip, tcp_port: v.tcp_port ?? null, notes: v.notes, enabled: v.enabled,
  }).select('id').single()
  if (error || !data) return { ok: false, error: sanitizeError(error, { route: 'createDevice', fallback: 'Could not save the device.' }) }
  await addAudit(admin, { orgId: actor.orgId, actorId: actor.id, action: 'device_created', entityType: 'device', entityId: data.id })
  return { ok: true, deviceId: data.id }
}

export async function updateDevice(admin: AdminClient, actor: Actor, deviceId: string, input: unknown): Promise<Result<object>> {
  if (!isAdminRole(actor.role)) return { ok: false, error: DENIED }
  const c = await checked(admin, actor, input)
  if (!c.value) return { ok: false, error: c.error }
  const v = c.value
  const { data, error } = await admin.from('assets').update({
    location_id: v.store_id ?? null, type: v.type, name: v.name, ip: v.ip, tcp_port: v.tcp_port ?? null, notes: v.notes, enabled: v.enabled,
  }).eq('id', deviceId).eq('org_id', actor.orgId).is('archived_at', null).select('id')
  if (error) return { ok: false, error: sanitizeError(error, { route: 'updateDevice', fallback: 'Could not save the device.' }) }
  if (!data?.length) return { ok: false, error: 'Device not found.' }
  await addAudit(admin, { orgId: actor.orgId, actorId: actor.id, action: 'device_updated', entityType: 'device', entityId: deviceId })
  return { ok: true }
}

export async function deleteDevice(admin: AdminClient, actor: Actor, deviceId: string): Promise<Result<object>> {
  if (!isAdminRole(actor.role)) return { ok: false, error: DENIED }
  // P2-5a: deleting is archiving (switched off, endpoints freed, monitoring history and grants kept).
  const { data: found } = await admin.from('assets').select('id').eq('id', deviceId).eq('org_id', actor.orgId).is('archived_at', null).maybeSingle()
  if (!found) return { ok: false, error: 'Device not found.' }
  const { error } = await admin.rpc('inventory_archive', { p_org: actor.orgId, p_kind: 'asset', p_id: deviceId, p_actor: actor.id })
  if (error) return { ok: false, error: sanitizeError(error, { route: 'deleteDevice', fallback: 'Could not delete the device.' }) }
  await addAudit(admin, { orgId: actor.orgId, actorId: actor.id, action: 'device_deleted', entityType: 'device', entityId: deviceId })
  return { ok: true }
}
