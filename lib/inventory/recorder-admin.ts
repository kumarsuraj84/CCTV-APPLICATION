import { addAudit } from '@/lib/admin/audit'
import type { Actor, AdminClient, Result } from '@/lib/admin/types'
import { cleanId, inventoryAdmin, type InventoryClients } from '@/lib/inventory/admin-gate'
import { ensurePlaceholderCameras } from '@/lib/inventory/cameras'
import { isHostOrIp, optionalText, parseClockOffset, parseWhole } from '@/lib/inventory/forms'
import { isMonitored, MSG_MONITORING_OFF, readRecorderPassword } from '@/lib/inventory/recorders'
import { loginBlockMessage, MSG_LOGIN_BACKOFF } from '@/lib/monitor/login-backoff'
import { gateLoginPatiently, guardNvrClient, LoginTicket, MSG_LOGIN_STATE_UNREADABLE } from '@/lib/nvr/login-guard'
import { realProbes } from '@/lib/monitor/probes'
import type { Probes } from '@/lib/monitor/types'
import { describeNvrError, NvrError } from '@/lib/nvr/client'
import { sanitizeError } from '@/lib/observability/sanitize-error'
import { registerEndpoints } from '@/lib/security/targets'

// The NVRs (recorders) of a location (P2-5c-1 brief item 2). A location has 1..n NVRs (a head office may have none). Each NVR has its
// own address, ports, login name, number of cameras and clock offset; its password is WRITE-ONLY: it goes to the vault through
// recorder_store_credential and is never read back to a screen, a result, a log or an audit row (the screens show only "a password is
// saved"). The connection test is read-only (one ISAPI GET of the channel status) through the logged credential read
// (recorder_credential_read, purpose connection_test, which refuses a switched-off NVR; P2-6), and after a refused login it waits — like the worker's back-off (R9) —
// so a wrong password can never lock the NVR's account from this screen either.

export const MSG_NVR_NOT_FOUND = 'NVR not found.'
export const MSG_NEED_PASSWORD = 'Enter the NVR password.'
export const MSG_ADDRESS_TAKEN_HERE = 'Another NVR of this location already has this address.'
export const MSG_ADDRESS_SHARED_ELSEWHERE = 'This NVR address is also used by an NVR of another location. Check that it is right.'
/** The shared login back-off (review I-3): the same words for the connection test and discovery. */
export const MSG_TEST_BACKOFF = MSG_LOGIN_BACKOFF
/** Review I-4: the saved password is used only for the address and web port it was saved for. */
export const MSG_PASSWORD_AGAIN = 'The address or web port changed: enter the NVR password again (the saved one is only used for the address it was saved for).'

/** Whether a saved NVR address (host, web port) differs from the one being saved (host compared without case and spaces). */
export const addressChanged = (savedHost: string | null, savedPort: number, host: string, port: number): boolean =>
  (savedHost ?? '').trim().toLowerCase() !== host.trim().toLowerCase() || savedPort !== port

export type RecorderInput = {
  id?: string | null; name: string; host: string; httpPort: number | string; rtspPort: number | string; username: string
  /** Write-only. Empty keeps the saved password (an existing NVR); a new NVR needs one. */
  password?: string | null
  expectedChannels: number | string; clockOffsetSec: string | number | null
}

async function liveLocation(admin: AdminClient, orgId: string, id: string | null) {
  if (!id) return null
  const { data } = await admin.from('locations').select('id').eq('id', id).eq('org_id', orgId).is('archived_at', null).maybeSingle()
  return data
}

/** Creates or changes one NVR of a location; returns its id and, when worth a look, a warning. Never returns or logs the password. */
export async function saveRecorder(clients: InventoryClients, actor: Actor, locationId: string, input: RecorderInput): Promise<Result<{ recorderId: string; warning?: string }>> {
  const may = await inventoryAdmin(clients.rls, actor)
  if (!may.ok) return may
  const admin = clients.admin
  const loc = cleanId(locationId)
  if (!(await liveLocation(admin, actor.orgId, loc)) || !loc) return { ok: false, error: 'Location not found.' }
  const name = optionalText(input?.name, 200)
  if (!name) return { ok: false, error: 'Enter a name for the NVR (for example Ground floor).' }
  const host = String(input?.host ?? '').trim()
  if (!isHostOrIp(host)) return { ok: false, error: 'Enter the NVR address (an IP address or a host name).' }
  const httpPort = parseWhole(input?.httpPort, 1, 65535, 80)
  const rtspPort = parseWhole(input?.rtspPort, 1, 65535, 554)
  if (httpPort == null || rtspPort == null) return { ok: false, error: 'A port must be a whole number from 1 to 65535.' }
  const username = optionalText(input?.username, 200)
  if (!username) return { ok: false, error: 'Enter the NVR user name.' }
  const channels = parseWhole(input?.expectedChannels, 0, 999, 0)
  if (channels == null) return { ok: false, error: 'The number of cameras must be a whole number from 0 to 999.' }
  const offset = parseClockOffset(input?.clockOffsetSec)
  if (!offset.ok) return offset
  const password = typeof input?.password === 'string' && input.password !== '' ? input.password : null
  if (password !== null && password.length > 200) return { ok: false, error: 'The password is too long.' }
  let current: string | null = null
  if (input?.id) {
    current = cleanId(input.id)
    const { data } = current
      ? await admin.from('recorders').select('id, http_port, assets!recorders_asset_fk!inner(archived_at, ip)').eq('id', current).eq('org_id', actor.orgId).eq('location_id', loc).is('assets.archived_at', null).maybeSingle()
      : { data: null }
    if (!data) return { ok: false, error: MSG_NVR_NOT_FOUND }
    // Review I-4: the saved password belongs to the address it was saved for. A new address or web port without the password would
    // send that password (a Digest answer to it) to whatever answers there: refused before anything changes.
    const saved = data as unknown as { http_port: number; assets: { ip: string | null } }
    if (!password && addressChanged(saved.assets.ip, saved.http_port, host, httpPort)) return { ok: false, error: MSG_PASSWORD_AGAIN }
  } else if (!password) return { ok: false, error: MSG_NEED_PASSWORD }

  // Final clean-up (review C M-29): the NVR, its password and its clock offset in ONE database transaction (recorder_save_login):
  // a new NVR whose password cannot be saved leaves nothing behind, and a new address never keeps the old password (DR011, the same
  // rule as above, checked again under the row lock). The organisation and the actor are named; the database checks both and writes
  // the recorder_created / _updated and recorder_password_set audit rows. The saved-login version follows the new secret (NB-10).
  const { data: saved, error: saveError } = await admin.rpc('recorder_save_login', {
    p_org: actor.orgId, p_location: loc, p_recorder: current as string, p_host: host, p_http_port: httpPort, p_rtsp_port: rtspPort, p_username: username,
    p_expected_channels: channels, p_name: name, p_actor: actor.id, p_secret: password as string, p_clock_offset_sec: offset.value as number,
  })
  if (saveError || !saved) {
    if (saveError?.code === 'DR010') return { ok: false, error: MSG_ADDRESS_TAKEN_HERE }
    if (saveError?.code === 'DR011') return { ok: false, error: MSG_PASSWORD_AGAIN }
    if (saveError?.code === 'P0002') return { ok: false, error: MSG_NVR_NOT_FOUND }
    return { ok: false, error: sanitizeError(saveError, { route: 'saveRecorder', fallback: 'Could not save the NVR and its password. Nothing was changed.' }) }
  }
  const recorderId = saved as string
  try {
    await ensurePlaceholderCameras(admin, actor.orgId, loc, recorderId, channels)
  } catch (e) {
    sanitizeError(e, { route: 'saveRecorder.cameras' })
    return { ok: true, recorderId, warning: 'The NVR was saved, but its cameras could not be made yet. Use "Find cameras" on this NVR.' }
  }
  const warning = (await sharedElsewhere(admin, actor.orgId, loc, recorderId, host, httpPort)) ? MSG_ADDRESS_SHARED_ELSEWHERE : undefined
  return warning ? { ok: true, recorderId, warning } : { ok: true, recorderId }
}

/** The same address and web port as an NVR of ANOTHER location: saved (decision D5-8), but probably a typo on this all-VPN network. */
async function sharedElsewhere(admin: AdminClient, orgId: string, locationId: string, recorderId: string, host: string, port: number): Promise<boolean> {
  const { data, error } = await admin.from('assets').select('id').eq('org_id', orgId).eq('is_recorder', true).is('archived_at', null)
    .eq('ip', host).eq('tcp_port', port).neq('id', recorderId).neq('location_id', locationId).limit(1)
  if (error) {
    sanitizeError(error, { route: 'saveRecorder.addressCheck' })
    return false
  }
  return (data ?? []).length > 0
}

/** Switches monitoring of one NVR off (nothing contacts it or its cameras) or on, with a reason (the database checks and audits). */
export async function setRecorderMonitoring(clients: InventoryClients, actor: Actor, recorderId: string, input: { enabled: boolean; reason: string }): Promise<Result<object>> {
  const may = await inventoryAdmin(clients.rls, actor)
  if (!may.ok) return may
  const id = cleanId(recorderId)
  if (!id) return { ok: false, error: MSG_NVR_NOT_FOUND }
  const reason = typeof input?.reason === 'string' ? input.reason.trim() : ''
  if (reason.length < 3 || reason.length > 500) return { ok: false, error: 'Give a reason (at least three characters).' }
  const { error } = await clients.admin.rpc('recorder_set_monitoring', { p_org: actor.orgId, p_recorder: id, p_enabled: input.enabled === true, p_reason: reason, p_actor: actor.id })
  if (error) {
    if (error.code === 'P0002') return { ok: false, error: MSG_NVR_NOT_FOUND }
    if (error.code === '42501') return { ok: false, error: 'Only a super administrator, or an administrator with inventory rights for the whole organisation, may do this.' }
    return { ok: false, error: sanitizeError(error, { route: 'setRecorderMonitoring', fallback: 'Could not change the monitoring of this NVR.' }) }
  }
  return { ok: true }
}

// After a refused login this NVR is not asked again until the window is over or its saved login changes — the ONE shared back-off of
// every process (final fix X, NB-1: lib/nvr/login-guard.ts, in the database). `backoffSec`: the first window (tests).
type TestDeps = { nvr: Probes['nvr']; backoffSec?: number }

/** Asks the NVR once, read-only, whether the saved login works and how many cameras it reports. */
export async function testRecorderConnection(clients: InventoryClients, actor: Actor, recorderId: string, deps: TestDeps = { nvr: realProbes.nvr }): Promise<Result<{ message: string; channels: number }>> {
  const may = await inventoryAdmin(clients.rls, actor)
  if (!may.ok) return may
  const id = cleanId(recorderId)
  if (!id) return { ok: false, error: MSG_NVR_NOT_FOUND }
  const admin = clients.admin
  const { data: r, error } = await admin.from('recorders')
    .select('id, http_port, username, monitoring_enabled, assets!recorders_asset_fk!inner(ip, enabled, archived_at), locations!recorders_location_fk!inner(is_active, archived_at)')
    .eq('id', id).eq('org_id', actor.orgId).maybeSingle()
  if (error) return { ok: false, error: sanitizeError(error, { route: 'testRecorderConnection', fallback: 'Could not read the NVR.' }) }
  const row = r as unknown as { id: string; http_port: number; username: string | null; monitoring_enabled: boolean; assets: { ip: string | null; enabled: boolean; archived_at: string | null }; locations: { is_active: boolean; archived_at: string | null } } | null
  if (!row || row.locations.archived_at) return { ok: false, error: MSG_NVR_NOT_FOUND }
  if (row.assets.archived_at) return { ok: false, error: 'This NVR is archived. Restore it first.' }
  if (!isMonitored(row)) return { ok: false, error: MSG_MONITORING_OFF }
  if (!row.locations.is_active) return { ok: false, error: 'This location is switched off. Switch it on before testing its NVRs.' }
  if (!row.assets.ip) return { ok: false, error: 'This NVR has no address saved.' }
  // P2-6 (SO-4): the NVR as saved in the database is the registered endpoint the test may reach (lib/security/targets.ts).
  registerEndpoints([{ host: row.assets.ip, port: row.http_port }])
  const credentials = clients.credentials ?? admin
  // Final fix X (ruling NB-1): the ONE shared login back-off (in the database; the worker, discovery, live video and playback use the
  // same), asked before the password is read.
  let gate
  try {
    gate = await gateLoginPatiently(credentials, id, { path: 'connection_test' })
  } catch {
    return { ok: false, error: MSG_LOGIN_STATE_UNREADABLE }
  }
  if (gate.decision === 'no_password') return { ok: false, error: 'This NVR has no password saved yet.' }
  const blocked = loginBlockMessage(gate)
  if (blocked) return { ok: false, error: blocked }
  const ticket = new LoginTicket(credentials, id, gate, 'connection_test', deps.backoffSec ? { baseSec: deps.backoffSec, maxSec: Math.max(deps.backoffSec, 21_600) } : undefined)
  const read = await readRecorderPassword(credentials, id, 'connection_test', actor.id)
  if (!read.ok || !read.password) await ticket.close()
  if (!read.ok) return { ok: false, error: sanitizeError({ code: read.code }, { route: 'testRecorderConnection', fallback: 'Could not read the NVR password.' }) }
  if (!read.password) return { ok: false, error: 'This NVR has no password saved yet.' }
  const host = row.assets.ip
  const username = row.username ?? ''
  let outcome: string
  try {
    const status = await guardNvrClient(deps.nvr({ host, port: row.http_port, username, password: read.password }, { timeoutMs: 8000 }), ticket).channelStatus()
    outcome = 'ok'
    await addAudit(admin, { orgId: actor.orgId, actorId: actor.id, action: 'recorder_connection_tested', entityType: 'recorder', entityId: id, detail: { outcome, channels: status.size } })
    const n = status.size
    return { ok: true, channels: n, message: `The NVR answered and accepted the login. It reports ${n} ${n === 1 ? 'camera' : 'cameras'}.` }
  } catch (e) {
    outcome = e instanceof NvrError ? e.kind : 'failed'
    await ticket.close()
    await addAudit(admin, { orgId: actor.orgId, actorId: actor.id, action: 'recorder_connection_tested', entityType: 'recorder', entityId: id, detail: { outcome } })
    return { ok: false, error: describeNvrError(e) }
  }
}
