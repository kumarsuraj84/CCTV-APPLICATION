import { addAudit } from '@/lib/admin/audit'
import { isAdminRole } from '@/lib/admin/roles'
import type { Actor, AdminClient, Result } from '@/lib/admin/types'
import { realProbes } from '@/lib/monitor/probes'
import type { Probes } from '@/lib/monitor/types'
import { describeNvrError } from '@/lib/nvr/client'
import { sanitizeError } from '@/lib/observability/sanitize-error'

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const MAX_NAME = 200

/**
 * Reads the camera list from the store's NVR and saves names and addresses. Cameras are matched by (store, channel), so their ids stay the same.
 * Nothing is deleted. One attempt only: a refused login is reported, never retried (a wrong password must not lock the NVR account).
 */
export async function discoverStoreCameras(
  admin: AdminClient,
  actor: Actor,
  storeId: string,
  deps: { nvr: Probes['nvr'] } = { nvr: realProbes.nvr },
): Promise<Result<{ cameras: number; created: number; updated: number }>> {
  if (!isAdminRole(actor.role)) return { ok: false, error: 'Only administrators can look for cameras.' }
  if (!UUID.test(storeId)) return { ok: false, error: 'Store not found.' }
  const { data: store, error: storeError } = await admin
    .from('stores')
    .select('id, nvr_ip, http_port, nvr_username')
    .eq('id', storeId)
    .eq('org_id', actor.orgId)
    .maybeSingle()
  if (storeError) return { ok: false, error: sanitizeError(storeError, { route: 'discoverStoreCameras', fallback: 'Could not read the store.' }) }
  if (!store) return { ok: false, error: 'Store not found.' }

  // The password is read here, used for this one call and not kept anywhere.
  const { data: password, error: passwordError } = await admin.rpc('nvr_read_credential', { p_store: store.id })
  if (passwordError) return { ok: false, error: sanitizeError(passwordError, { route: 'discoverStoreCameras', fallback: 'Could not read the NVR password.' }) }
  if (!password) return { ok: false, error: 'This store has no NVR password saved. Add it on the Manage stores page first.' }

  let channels
  try {
    channels = await deps.nvr({ host: store.nvr_ip, port: store.http_port, username: store.nvr_username, password }).channels()
  } catch (e) {
    return { ok: false, error: describeNvrError(e) }
  }
  if (channels.length === 0) return { ok: false, error: 'The NVR did not list any cameras.' }

  const { data: existing, error: existingError } = await admin
    .from('cameras')
    .select('channel, name, camera_ip')
    .eq('store_id', store.id)
    .eq('org_id', actor.orgId)
  if (existingError) return { ok: false, error: sanitizeError(existingError, { route: 'discoverStoreCameras', fallback: 'Could not read the cameras.' }) }
  const known = new Map((existing ?? []).map((c) => [c.channel, c]))

  const rows = channels.map((c) => {
    const old = known.get(c.channel)
    const placeholder = `Camera ${c.channel}`
    const reported = c.name.trim() || placeholder
    return {
      org_id: actor.orgId,
      store_id: store.id,
      channel: c.channel,
      // A name the NVR only made up (its own placeholder) does not overwrite a name somebody chose.
      name: (reported === placeholder && old?.name ? old.name : reported).slice(0, MAX_NAME),
      // An address the NVR does not report now is not forgotten.
      camera_ip: c.ip ?? old?.camera_ip ?? null,
    }
  })
  const { error } = await admin.from('cameras').upsert(rows, { onConflict: 'store_id,channel' })
  if (error) return { ok: false, error: sanitizeError(error, { route: 'discoverStoreCameras', fallback: 'Could not save the cameras.' }) }

  const created = rows.filter((r) => !known.has(r.channel)).length
  const updated = rows.length - created
  await addAudit(admin, { orgId: actor.orgId, actorId: actor.id, action: 'cameras_discovered', entityType: 'store', entityId: store.id, detail: { created, updated } })
  return { ok: true, cameras: rows.length, created, updated }
}
