import { isAdminRole } from '@/lib/admin/roles'
import type { Actor, AdminClient, Result } from '@/lib/admin/types'
import { auditAccess } from '@/lib/auth/access-audit'
import { locationFor } from '@/lib/auth/resource'
import { MSG_MONITORING_OFF } from '@/lib/inventory/recorders'
import { realProbes } from '@/lib/monitor/probes'
import type { Probes } from '@/lib/monitor/types'
import { describeNvrError } from '@/lib/nvr/client'
import { sanitizeError } from '@/lib/observability/sanitize-error'

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const MAX_NAME = 200

const DENIED = 'Only administrators can look for cameras.'

/**
 * Reads the camera list from the store's NVR and saves names and addresses. Cameras are matched by (store, channel), so their ids stay the same.
 * Nothing is deleted. One attempt only: a refused login is reported, never retried (a wrong password must not lock the NVR account).
 *
 * Who (P2-2): an administrative role (admin / platform owner) AND admin.inventory covering this store, asked as the person
 * (has_capability_for(admin.inventory, 'location', store): admin.inventory is organisation-wide, so this also proves the store is in
 * the person's organisation). Only then are the NVR address and password read with the service role, scoped to the organisation.
 */
export async function discoverStoreCameras(
  clients: { admin: AdminClient; rls: AdminClient },
  actor: Actor,
  storeId: string,
  deps: { nvr: Probes['nvr'] } = { nvr: realProbes.nvr },
): Promise<Result<{ cameras: number; created: number; updated: number }>> {
  if (!isAdminRole(actor.role)) return { ok: false, error: DENIED }
  if (typeof storeId !== 'string' || !UUID.test(storeId)) return { ok: false, error: 'Store not found.' }
  const allowed = await locationFor(clients.rls, 'admin.inventory', storeId)
  if (!allowed.ok) return { ok: false, error: allowed.error }
  if (!allowed.allowed) {
    // A store of another organisation (or none) and a person without admin.inventory: told apart only by what they could know anyway.
    const exists = await clients.admin.from('locations').select('id').eq('id', storeId).eq('org_id', actor.orgId).is('archived_at', null).maybeSingle()
    return { ok: false, error: exists.data ? DENIED : 'Store not found.' }
  }
  const admin = clients.admin
  const { data: store, error: storeError } = await admin
    .from('locations')
    .select('id, nvr_ip, http_port, nvr_username')
    .eq('id', storeId)
    .eq('org_id', actor.orgId)
    .is('archived_at', null)
    .maybeSingle()
  if (storeError) return { ok: false, error: sanitizeError(storeError, { route: 'discoverStoreCameras', fallback: 'Could not read the store.' }) }
  if (!store || !store.nvr_ip) return { ok: false, error: 'Store not found.' }

  // P2-5a: the location's primary recorder (seam, D5-7); per-recorder discovery is P2-5b. Owner addition: a switched-off NVR is never
  // contacted (checked before its password is read).
  const { data: recorderId, error: recorderError } = await admin.rpc('recorder_primary_of', { p_location: store.id })
  if (recorderError) return { ok: false, error: sanitizeError(recorderError, { route: 'discoverStoreCameras', fallback: 'Could not read the store.' }) }
  if (!recorderId) return { ok: false, error: 'Store not found.' }
  const { data: recorder } = await admin.from('recorders').select('monitoring_enabled').eq('id', recorderId as string).maybeSingle()
  if (!recorder?.monitoring_enabled) return { ok: false, error: MSG_MONITORING_OFF }

  // The password is read here, used for this one call and not kept anywhere.
  const { data: password, error: passwordError } = await admin.rpc('nvr_read_credential', { p_store: store.id })
  if (passwordError) return { ok: false, error: sanitizeError(passwordError, { route: 'discoverStoreCameras', fallback: 'Could not read the NVR password.' }) }
  if (!password) return { ok: false, error: 'This store has no NVR password saved. Add it on the Manage stores page first.' }

  let channels
  try {
    channels = await deps.nvr({ host: store.nvr_ip, port: store.http_port, username: store.nvr_username ?? '', password }).channels()
  } catch (e) {
    return { ok: false, error: describeNvrError(e) }
  }
  if (channels.length === 0) return { ok: false, error: 'The NVR did not list any cameras.' }

  // Cameras are matched by (recorder, channel) — the active mapping — so a camera keeps its id; cameras of the location without a
  // mapping are matched by channel. Never a second identity for the same channel (brief P2-5b keeps the full reconciliation).
  const { data: existing, error: existingError } = await admin
    .from('cameras')
    .select('id, channel, name, camera_ip, recorder_id')
    .eq('location_id', store.id)
    .eq('org_id', actor.orgId)
    .is('archived_at', null)
  if (existingError) return { ok: false, error: sanitizeError(existingError, { route: 'discoverStoreCameras', fallback: 'Could not read the cameras.' }) }
  const known = new Map((existing ?? []).filter((c) => c.recorder_id === recorderId || c.recorder_id === null).map((c) => [c.channel, c]))

  const rows = channels.map((c) => {
    const old = known.get(c.channel)
    const placeholder = `Camera ${c.channel}`
    const reported = c.name.trim() || placeholder
    return {
      id: old?.id,
      org_id: actor.orgId,
      location_id: store.id,
      recorder_id: recorderId as string,
      channel: c.channel,
      // A name the NVR only made up (its own placeholder) does not overwrite a name somebody chose.
      name: (reported === placeholder && old?.name ? old.name : reported).slice(0, MAX_NAME),
      // An address the NVR does not report now is not forgotten.
      camera_ip: c.ip ?? old?.camera_ip ?? null,
    }
  })
  const fresh = rows.filter((r) => !r.id).map((r) => ({ org_id: r.org_id, location_id: r.location_id, recorder_id: r.recorder_id, channel: r.channel, name: r.name, camera_ip: r.camera_ip }))
  if (fresh.length > 0) {
    const { error } = await admin.from('cameras').insert(fresh)
    if (error) return { ok: false, error: sanitizeError(error, { route: 'discoverStoreCameras', fallback: 'Could not save the cameras.' }) }
  }
  for (const r of rows.filter((x) => x.id)) {
    const { error } = await admin.from('cameras').update({ name: r.name, camera_ip: r.camera_ip, recorder_id: r.recorder_id }).eq('id', r.id as string).eq('org_id', actor.orgId)
    if (error) return { ok: false, error: sanitizeError(error, { route: 'discoverStoreCameras', fallback: 'Could not save the cameras.' }) }
  }

  const created = rows.filter((r) => !known.has(r.channel)).length
  const updated = rows.length - created
  await auditAccess(admin, { orgId: actor.orgId, actorId: actor.id, action: 'cameras_discovered', capability: 'admin.inventory', locationIds: [store.id], detail: { created, updated } })
  return { ok: true, cameras: rows.length, created, updated }
}
