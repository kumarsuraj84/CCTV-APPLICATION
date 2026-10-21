import type { Actor, AdminClient, Result } from '@/lib/admin/users'
import { addAudit } from '@/lib/admin/audit'
import { isAdminRole } from '@/lib/auth/roles'
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
      await assertRefsInOrg(admin, actor.orgId, [{ table: 'stores', ids: [v.store_id] }])
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
  const { data, error } = await admin.from('devices').insert({
    org_id: actor.orgId, store_id: v.store_id ?? null, type: v.type, name: v.name, ip: v.ip, tcp_port: v.tcp_port ?? null, notes: v.notes, enabled: v.enabled,
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
  const { data, error } = await admin.from('devices').update({
    store_id: v.store_id ?? null, type: v.type, name: v.name, ip: v.ip, tcp_port: v.tcp_port ?? null, notes: v.notes, enabled: v.enabled,
  }).eq('id', deviceId).eq('org_id', actor.orgId).select('id')
  if (error) return { ok: false, error: sanitizeError(error, { route: 'updateDevice', fallback: 'Could not save the device.' }) }
  if (!data?.length) return { ok: false, error: 'Device not found.' }
  await addAudit(admin, { orgId: actor.orgId, actorId: actor.id, action: 'device_updated', entityType: 'device', entityId: deviceId })
  return { ok: true }
}

export async function deleteDevice(admin: AdminClient, actor: Actor, deviceId: string): Promise<Result<object>> {
  if (!isAdminRole(actor.role)) return { ok: false, error: DENIED }
  const { data, error } = await admin.from('devices').delete().eq('id', deviceId).eq('org_id', actor.orgId).select('id')
  if (error) return { ok: false, error: sanitizeError(error, { route: 'deleteDevice', fallback: 'Could not delete the device.' }) }
  if (!data?.length) return { ok: false, error: 'Device not found.' }
  await addAudit(admin, { orgId: actor.orgId, actorId: actor.id, action: 'device_deleted', entityType: 'device', entityId: deviceId })
  return { ok: true }
}
