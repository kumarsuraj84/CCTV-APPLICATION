'use server'

// Server Actions of the P2-5c-1 administration screens: regions, clusters, moves, zone → cluster proposals, locations, network
// definitions, NVRs, the mapping editor, merge, the reconciliation list, archive and restore. Every action first checks the caller
// (requireAdministration: signed in, active, password chosen, administrative role AND admin.inventory for the whole organisation;
// everybody else is sent home before anything else happens); the service then checks the role and the capability again from the
// person's own summary and scopes every write to the person's organisation. They return plain results and never throw to the client.
import { revalidatePath } from 'next/cache'
import { requireAdministration } from '@/lib/auth/profile'
import { archiveInventory, restoreInventory, type ArchiveKind } from '@/lib/inventory/archive'
import { dismissFinding, linkFinding } from '@/lib/inventory/findings'
import { mergeSentence, MSG_OPEN_VIDEO, type MergePreview } from '@/lib/inventory/forms'
import {
  applyProposals, moveNode, previewMove, previewProposals, saveCluster, saveRegion, type MoveInput, type MovePreview, type ProposalChoice, type ProposalPreview,
} from '@/lib/inventory/hierarchy'
import { saveLocation, saveNetworkDefinition } from '@/lib/inventory/locations'
import { mergeCameras, previewMerge, remapCamera, searchCameras } from '@/lib/inventory/mapping'
import { checkMergeConfirmation, mergeConfirmation, MSG_MERGE_CONFIRM_AGAIN } from '@/lib/inventory/merge-confirm'
import { cleanId } from '@/lib/inventory/admin-gate'
import { saveRecorder, setRecorderMonitoring, testRecorderConnection } from '@/lib/inventory/recorder-admin'
import { discoverRecorderCameras } from '@/lib/monitor/discovery'
import { discoverySummary } from '@/lib/monitor/discovery-summary'
import { realProbes } from '@/lib/monitor/probes'
import { submittedValues } from '@/lib/forms/submitted-values'
import { rateLimit } from '@/lib/rate-limit'
import { localGo2rtc } from '@/lib/streams/local-go2rtc'
import { createAdminClient } from '@/lib/supabase/admin'
import { createClient } from '@/lib/supabase/server'

/** What the forms and buttons get back. `values`: the submitted non-secret fields after an error (never a password). */
export type AdminActionState = { ok?: boolean; error?: string; message?: string; warning?: string; id?: string; details?: string[]; values?: Record<string, string> }

async function ctx(withStreams = false) {
  const p = await requireAdministration('admin.inventory')
  return {
    clients: { admin: createAdminClient(), rls: await createClient(), ...(withStreams ? { go2rtc: localGo2rtc() } : {}) },
    actor: { id: p.id, orgId: p.org_id, role: p.role },
  }
}

const text = (f: FormData, k: string) => String(f.get(k) ?? '')
const MSG_SLOW_DOWN = 'Too many requests in a short time. Wait a minute and try again.'
/** Every screen of the hierarchy shows counts of the others, so a change refreshes all of them (and the old store pages). */
function refresh() {
  for (const p of ['/admin/locations', '/admin/regions', '/admin/reconciliation', '/admin/assets', '/admin/stores', '/stores']) revalidatePath(p, 'layout')
}
const done = <T extends { ok: true } | { ok: false; error: string }>(res: T, okState: (r: Extract<T, { ok: true }>) => AdminActionState): AdminActionState =>
  res.ok ? okState(res as Extract<T, { ok: true }>) : { error: (res as { error: string }).error }

// ── Regions and clusters ────────────────────────────────────────────────────────────────────────────────────────────────────
export async function saveRegionAction(_prev: AdminActionState, f: FormData): Promise<AdminActionState> {
  const { clients, actor } = await ctx()
  const res = await saveRegion(clients, actor, { id: text(f, 'id') || null, code: text(f, 'code'), name: text(f, 'name') })
  refresh()
  return res.ok ? { ok: true, id: res.id, message: 'Region saved.' } : { error: res.error, values: submittedValues(f, ['code', 'name']) }
}

export async function saveClusterAction(_prev: AdminActionState, f: FormData): Promise<AdminActionState> {
  const { clients, actor } = await ctx()
  const res = await saveCluster(clients, actor, { id: text(f, 'id') || null, code: text(f, 'code'), name: text(f, 'name'), regionId: text(f, 'region_id') || null })
  refresh()
  return res.ok ? { ok: true, id: res.id, message: 'Cluster saved.' } : { error: res.error, values: submittedValues(f, ['code', 'name', 'region_id']) }
}

export type PreviewMoveState = ({ ok: true } & MovePreview) | { ok: false; error: string }
export async function previewMoveAction(input: MoveInput): Promise<PreviewMoveState> {
  const { clients, actor } = await ctx()
  if (await limited('preview', actor.id, 30)) return { ok: false, error: MSG_SLOW_DOWN }
  return previewMove(clients, actor, input)
}

export async function moveNodeAction(input: MoveInput): Promise<AdminActionState> {
  const { clients, actor } = await ctx()
  const res = await moveNode(clients, actor, input)
  refresh()
  // Review I-1 / M-13: the true statement about video already open (P2-4: the session registry stops it within a minute).
  return done(res, () => ({ ok: true, message: `Moved. Access follows the new place at once. ${MSG_OPEN_VIDEO}` }))
}

export type PreviewProposalsState = ({ ok: true } & ProposalPreview) | { ok: false; error: string }
export async function previewProposalsAction(items: ProposalChoice[]): Promise<PreviewProposalsState> {
  const { clients, actor } = await ctx()
  if (await limited('preview', actor.id, 30)) return { ok: false, error: MSG_SLOW_DOWN }
  return previewProposals(clients, actor, Array.isArray(items) ? items : [])
}

export async function applyProposalsAction(items: ProposalChoice[]): Promise<AdminActionState> {
  const { clients, actor } = await ctx()
  const res = await applyProposals(clients, actor, Array.isArray(items) ? items : [])
  refresh()
  return done(res, (r) => ({ ok: true, message: `Applied to ${r.moved} ${r.moved === 1 ? 'location' : 'locations'} (${r.regionsCreated} new regions, ${r.clustersCreated} new clusters).` }))
}

// ── Locations ──────────────────────────────────────────────────────────────────────────────────────────────────────────────
const LOCATION_FIELDS = ['code', 'kind', 'name', 'city', 'address', 'zone', 'state', 'cluster_id']
export async function saveLocationAction(_prev: AdminActionState, f: FormData): Promise<AdminActionState> {
  const { clients, actor } = await ctx()
  const res = await saveLocation(clients, actor, {
    id: text(f, 'id') || null, code: text(f, 'code'), kind: text(f, 'kind'), name: text(f, 'name'), city: text(f, 'city'), address: text(f, 'address'),
    zone: text(f, 'zone'), state: text(f, 'state'), clusterId: text(f, 'cluster_id') || null, isActive: f.get('is_active') === 'on',
  })
  refresh()
  return res.ok ? { ok: true, id: res.locationId, message: 'Location saved.' } : { error: res.error, values: submittedValues(f, LOCATION_FIELDS, ['is_active']) }
}

const NETWORK_FIELDS = ['management_cidr', 'gateway', 'dns', 'management_vlan', 'vlan_staff', 'vlan_guest', 'vlan_device', 'vlan_other', 'discovery_ranges', 'sdwan_context']
export async function saveNetworkAction(locationId: string, _prev: AdminActionState, f: FormData): Promise<AdminActionState> {
  const { clients, actor } = await ctx()
  const res = await saveNetworkDefinition(clients, actor, String(locationId), {
    managementCidr: text(f, 'management_cidr'), gateway: text(f, 'gateway'), dns: text(f, 'dns'), managementVlan: text(f, 'management_vlan'),
    vlanStaff: text(f, 'vlan_staff'), vlanGuest: text(f, 'vlan_guest'), vlanDevice: text(f, 'vlan_device'), vlanOther: text(f, 'vlan_other'),
    discoveryRanges: text(f, 'discovery_ranges'), sdwanContext: text(f, 'sdwan_context'),
  })
  refresh()
  if (!res.ok) return { error: res.error, values: submittedValues(f, NETWORK_FIELDS) }
  return { ok: true, message: res.removed ? 'The network definition was removed.' : 'Network definition saved.' }
}

// ── NVRs ───────────────────────────────────────────────────────────────────────────────────────────────────────────────────
const RECORDER_FIELDS = ['name', 'host', 'http_port', 'rtsp_port', 'username', 'expected_channels', 'clock_offset_sec']
export async function saveRecorderAction(locationId: string, _prev: AdminActionState, f: FormData): Promise<AdminActionState> {
  const { clients, actor } = await ctx()
  const res = await saveRecorder(clients, actor, String(locationId), {
    id: text(f, 'id') || null, name: text(f, 'name'), host: text(f, 'host'), httpPort: text(f, 'http_port'), rtspPort: text(f, 'rtsp_port'),
    username: text(f, 'username'), password: text(f, 'password') || null, expectedChannels: text(f, 'expected_channels'), clockOffsetSec: text(f, 'clock_offset_sec'),
  })
  refresh()
  // The password is never sent back, not even after an error.
  if (!res.ok) return { error: res.error, values: submittedValues(f, RECORDER_FIELDS) }
  return { ok: true, id: res.recorderId, message: 'NVR saved.', ...(res.warning ? { warning: res.warning } : {}) }
}

export async function setMonitoringAction(recorderId: string, input: { enabled: boolean; reason: string }): Promise<AdminActionState> {
  const { clients, actor } = await ctx()
  const res = await setRecorderMonitoring(clients, actor, String(recorderId), { enabled: input?.enabled === true, reason: String(input?.reason ?? '') })
  refresh()
  return done(res, () => ({ ok: true, message: input?.enabled ? 'Monitoring is switched on for this NVR.' : 'Monitoring is switched off for this NVR. Nothing will contact it.' }))
}

const limited = async (kind: string, actorId: string, perMinute: number) => (await rateLimit(`inventory:${kind}:${actorId}`, perMinute, 60_000)).limited

export async function testConnectionAction(recorderId: string): Promise<AdminActionState> {
  const { clients, actor } = await ctx()
  if (await limited('test', actor.id, 6)) return { error: MSG_SLOW_DOWN }
  const res = await testRecorderConnection(clients, actor, String(recorderId), { nvr: realProbes.nvr })
  return done(res, (r) => ({ ok: true, message: r.message }))
}

/** "Find cameras" for ONE NVR (P2-5b discovery, per recorder): what it could not place lands in the reconciliation list. */
export async function discoverRecorderAction(recorderId: string): Promise<AdminActionState> {
  const { clients, actor } = await ctx(true)
  if (await limited('discover', actor.id, 6)) return { error: MSG_SLOW_DOWN }
  const res = await discoverRecorderCameras({ admin: clients.admin, rls: clients.rls }, actor, String(recorderId), { nvr: realProbes.nvr, go2rtc: clients.go2rtc })
  refresh()
  if (!res.ok) return { error: res.error }
  const { ok: _ok, ...result } = res
  void _ok
  const summary = discoverySummary({ cameras: result.cameras, created: result.created, updated: result.updated, mapped: result.mapped, moved: result.moved, recorders: [{ recorderId: result.recorderId, name: 'This NVR', ok: true, result }] })
  return { ok: true, message: summary.message, details: summary.details }
}

// ── Mapping editor, merge and reconciliation ───────────────────────────────────────────────────────────────────────────────
export async function remapCameraAction(input: { cameraId: string; recorderId: string; channel: number | string }): Promise<AdminActionState> {
  const { clients, actor } = await ctx(true)
  const res = await remapCamera(clients, actor, { cameraId: String(input?.cameraId ?? ''), recorderId: String(input?.recorderId ?? ''), channel: input?.channel ?? '' })
  refresh()
  return done(res, () => ({ ok: true, message: 'The camera now shows that NVR channel. Its access, groups and history stay.' }))
}

export type MergePreviewState = ({ ok: true } & MergePreview & { sentence: string; confirmation: string }) | { ok: false; error: string }
/**
 * What a merge would do, named, before the person confirms it (review I-5). The answer names the exact pair it describes and carries
 * a confirmation for that pair only (fix round 2, A-N1): the merge action refuses any other pair.
 */
export async function previewMergeAction(input: { keepId: string; duplicateId: string }): Promise<MergePreviewState> {
  const { clients, actor } = await ctx()
  if (await limited('preview', actor.id, 30)) return { ok: false, error: MSG_SLOW_DOWN }
  const res = await previewMerge(clients, actor, { keepId: String(input?.keepId ?? ''), duplicateId: String(input?.duplicateId ?? '') })
  if (!res.ok) return res
  return { ...res, sentence: mergeSentence(res), confirmation: mergeConfirmation({ actorId: actor.id, orgId: actor.orgId, keepId: res.keepId, duplicateId: res.duplicateId }) }
}

export type SearchCamerasState = { ok: true; cameras: { id: string; label: string }[] } | { ok: false; error: string }
/** Cameras of the whole organisation by name, for a merge across locations (review M-2). */
export async function searchCamerasAction(query: string): Promise<SearchCamerasState> {
  const { clients, actor } = await ctx()
  if (await limited('search', actor.id, 60)) return { ok: false, error: MSG_SLOW_DOWN }
  return searchCameras(clients, actor, String(query ?? ''))
}

/** Merges exactly the pair the person confirmed (fix round 2, A-N1): without a matching confirmation from previewMergeAction, nothing happens. */
export async function mergeCamerasAction(input: { keepId: string; duplicateId: string; confirmation: string }): Promise<AdminActionState> {
  const { clients, actor } = await ctx(true)
  const keepId = cleanId(input?.keepId)
  const duplicateId = cleanId(input?.duplicateId)
  if (!keepId || !duplicateId || !checkMergeConfirmation(input?.confirmation, { actorId: actor.id, orgId: actor.orgId, keepId, duplicateId })) {
    return { error: MSG_MERGE_CONFIRM_AGAIN }
  }
  const res = await mergeCameras(clients, actor, { keepId, duplicateId })
  refresh()
  return done(res, (r) => ({
    ok: true,
    message: `Merged. The kept camera now shows ${r.channel ? `channel ${r.channel} of that NVR` : 'its own channel'}; the other camera was archived.`,
    // Fix round 2 (A-N2): the database counts every holder of a grant on the archived camera; some of them may see the kept camera
    // through a wider grant, so the warning says what is certain.
    ...(r.duplicateCameraGrants > 0 ? { warning: `${r.duplicateCameraGrants} ${r.duplicateCameraGrants === 1 ? 'person had a grant' : 'people had grants'} on the archived camera itself; such grants are not moved. Give access to the kept camera to anyone who still needs it.` } : {}),
  }))
}

export async function dismissFindingAction(findingId: string, note: string): Promise<AdminActionState> {
  const { clients, actor } = await ctx()
  const res = await dismissFinding(clients, actor, String(findingId), String(note ?? ''))
  refresh()
  return done(res, () => ({ ok: true, message: 'Taken off the list.' }))
}

export async function linkFindingAction(findingId: string): Promise<AdminActionState> {
  const { clients, actor } = await ctx(true)
  const res = await linkFinding(clients, actor, String(findingId))
  refresh()
  return done(res, () => ({ ok: true, message: 'Linked. The existing camera shows that channel now.' }))
}

// ── Archive and restore from the new screens ───────────────────────────────────────────────────────────────────────────────
export async function archiveNodeAction(kind: ArchiveKind, id: string): Promise<AdminActionState> {
  const { clients, actor } = await ctx(true)
  const res = await archiveInventory(clients, actor, kind, String(id))
  refresh()
  return done(res, () => ({ ok: true, message: 'Archived. Its history is kept; restore brings it back.' }))
}

export async function restoreNodeAction(kind: ArchiveKind, id: string): Promise<AdminActionState> {
  const { clients, actor } = await ctx()
  const res = await restoreInventory({ admin: clients.admin, rls: clients.rls }, actor, kind, String(id))
  refresh()
  return done(res, () => ({ ok: true, message: kind === 'camera' || kind === 'location' ? 'Restored. Its cameras are not linked to an NVR yet: run "Find cameras" or link them.' : 'Restored.' }))
}
