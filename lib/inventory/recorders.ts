import type { AdminClient } from '@/lib/admin/types'
import { registerEndpoints } from '@/lib/security/targets'

// Recorders (NVRs) as explicit records (decision D-4; P2-5b: every code path runs on them). A location may have several NVRs, each with
// its own address, ports, login, clock offset and monitoring switch. A camera is reached ONLY through the recorder of its ACTIVE channel
// mapping (camera_channel_mappings, valid_to null): never through "the location's NVR", never through a guessed box.
//
// Owner addition 2026-10-22: monitoring can be switched off per NVR. Then nothing — the worker's checks, camera discovery, live video,
// playback or fast playback — opens a connection to it or to its cameras, and its cameras show "Switched off" instead of offline.
// Switching it is done by recorder_set_monitoring (super administrators or admin.inventory, with a reason, audited).

export const MSG_MONITORING_OFF = 'Monitoring is switched off for this NVR.'
/** A camera without an active channel mapping (just restored, or never linked) cannot be checked, watched or played back. */
export const MSG_NOT_MAPPED = 'This camera is not linked to an NVR yet.'

/** What the server knows about one recorder (service role only: the address and login name are IT information). */
export type Recorder = {
  id: string
  org_id: string
  location_id: string
  /** The location's code (for log lines and labels). */
  code: string
  name: string
  host: string | null
  http_port: number
  rtsp_port: number
  username: string
  /** Seconds to take off a shown time to get the NVR's time (ruling R13 direction); null = not measured or set (the default applies). */
  clock_offset_sec: number | null
  /** Switched on AND its asset enabled (review M4). */
  monitored: boolean
  /** Its location is switched on (P2-5b re-review N-3: discovery and the connection test never contact an NVR of a location that is off). */
  location_active: boolean
}

/** The way to one camera: the camera (with the channel of its ACTIVE mapping) and the recorder of that mapping. */
export type CameraRoute = {
  camera: { id: string; name: string; channel: number; location_id: string; code: string }
  recorder: Recorder
}
export type RouteAnswer = { kind: 'ok'; route: CameraRoute } | { kind: 'off'; camera: CameraRoute['camera'] } | { kind: 'unmapped'; camera: Omit<CameraRoute['camera'], 'channel'> & { channel: number | null } }

type RecorderRow = { id: string; location_id: string; migrated_from_location_id?: string | null }

/**
 * Each location's primary recorder from rows ordered by (created_at, id): the recorder the 5a data migration made for the location
 * (`migrated_from_location_id` = the location) when there is one, else the first one made. The same rule as the database's
 * `recorder_primary_of`. Only the legacy single-NVR forms and the legacy CSV ("location + primary recorder + channels") use it.
 */
export function pickPrimaries<T extends RecorderRow>(rows: readonly T[]): Map<string, T> {
  const out = new Map<string, T>()
  const isFirst = (r: T) => r.migrated_from_location_id === r.location_id
  for (const r of rows) {
    const current = out.get(r.location_id)
    if (!current || (isFirst(r) && !isFirst(current))) out.set(r.location_id, r)
  }
  return out
}

/** Monitoring counts only when it is switched on AND the recorder's asset is enabled (review M4). */
export function isMonitored(r: { monitoring_enabled: boolean; assets?: unknown }): boolean {
  const asset = (Array.isArray(r.assets) ? r.assets[0] : r.assets) as { enabled?: boolean } | null | undefined
  return r.monitoring_enabled && asset?.enabled !== false
}

const PIECE = 200
const RECORDER_COLUMNS =
  'id, org_id, location_id, http_port, rtsp_port, username, clock_offset_sec, monitoring_enabled, assets!recorders_asset_fk!inner(name, ip, enabled, archived_at), locations!recorders_location_fk!inner(code, is_active)'
type RecorderRead = {
  id: string; org_id: string; location_id: string; http_port: number; rtsp_port: number; username: string | null; clock_offset_sec: number | null
  monitoring_enabled: boolean; assets: { name: string; ip: string | null; enabled: boolean; archived_at: string | null }; locations: { code: string; is_active: boolean }
}

const toRecorder = (r: RecorderRead): Recorder => {
  // P2-6 (SO-4): an NVR read from the database is a registered endpoint: its web and video ports may be reached (lib/security/targets.ts).
  registerEndpoints([{ host: r.assets.ip, port: r.http_port }, { host: r.assets.ip, port: r.rtsp_port }])
  return {
    id: r.id, org_id: r.org_id, location_id: r.location_id, code: r.locations.code, name: r.assets.name, host: r.assets.ip,
    http_port: r.http_port, rtsp_port: r.rtsp_port, username: r.username ?? '', clock_offset_sec: r.clock_offset_sec, monitored: isMonitored(r),
    location_active: r.locations.is_active !== false,
  }
}

/** The non-archived recorders with these ids in the organisation (service role, after the person's own access check). */
export async function loadRecorders(admin: AdminClient, orgId: string, ids: readonly string[]): Promise<Map<string, Recorder>> {
  const out = new Map<string, Recorder>()
  const wanted = [...new Set(ids)]
  for (let i = 0; i < wanted.length; i += PIECE) {
    const { data, error } = await admin.from('recorders').select(RECORDER_COLUMNS).eq('org_id', orgId).in('id', wanted.slice(i, i + PIECE)).is('assets.archived_at', null)
    if (error) throw new Error('Could not read the recorders.')
    for (const r of (data ?? []) as unknown as RecorderRead[]) out.set(r.id, toRecorder(r))
  }
  return out
}

/** The non-archived recorders of a location, oldest first. */
export async function recordersOfLocation(admin: AdminClient, orgId: string, locationId: string): Promise<Recorder[]> {
  const { data, error } = await admin.from('recorders').select(RECORDER_COLUMNS).eq('org_id', orgId).eq('location_id', locationId).is('assets.archived_at', null)
    .order('created_at').order('id')
  if (error) throw new Error('Could not read the recorders.')
  return ((data ?? []) as unknown as RecorderRead[]).map(toRecorder)
}

/**
 * For each camera asked for (active, not archived, at an active location of the organisation): the recorder of its ACTIVE mapping and
 * the channel of that mapping — `ok`; `off` when that recorder is not monitored; `unmapped` when it has no active mapping (or the
 * mapping's recorder is archived). A camera that is not found (switched off, archived, another organisation) is simply absent.
 * Service role, after the person's own access check.
 */
export async function resolveCameraRoutes(admin: AdminClient, orgId: string, cameraIds: readonly string[]): Promise<Map<string, RouteAnswer>> {
  const out = new Map<string, RouteAnswer>()
  const wanted = [...new Set(cameraIds)]
  for (let i = 0; i < wanted.length; i += PIECE) {
    const part = wanted.slice(i, i + PIECE)
    const { data: cams, error } = await admin.from('cameras').select('id, name, location_id, locations!cameras_location_fk!inner(code, is_active, archived_at)')
      .eq('org_id', orgId).in('id', part).eq('is_active', true).is('archived_at', null).eq('locations.is_active', true).is('locations.archived_at', null)
    if (error) throw new Error('Could not read the cameras.')
    const found = (cams ?? []) as unknown as { id: string; name: string; location_id: string; locations: { code: string } }[]
    if (found.length === 0) continue
    const { data: maps, error: mErr } = await admin.from('camera_channel_mappings').select('camera_id, recorder_id, channel')
      .eq('org_id', orgId).in('camera_id', found.map((c) => c.id)).is('valid_to', null)
    if (mErr) throw new Error('Could not read the camera mappings.')
    const mapping = new Map((maps ?? []).map((m) => [m.camera_id, m]))
    const recorders = await loadRecorders(admin, orgId, (maps ?? []).map((m) => m.recorder_id))
    for (const c of found) {
      const m = mapping.get(c.id)
      const r = m ? recorders.get(m.recorder_id) : undefined
      // A mapping always points at a recorder of the camera's own location (SQLSTATE DR006); checked again here, never trusted blindly.
      if (!m || !r || r.location_id !== c.location_id) {
        out.set(c.id, { kind: 'unmapped', camera: { id: c.id, name: c.name, channel: m?.channel ?? null, location_id: c.location_id, code: c.locations.code } })
        continue
      }
      const camera = { id: c.id, name: c.name, channel: m.channel, location_id: c.location_id, code: c.locations.code }
      out.set(c.id, r.monitored ? { kind: 'ok', route: { camera, recorder: r } } : { kind: 'off', camera })
    }
  }
  return out
}

/**
 * Why an NVR login is read (P2-6, D-14). The database lets each service role read only for its own purposes (the worker: monitoring;
 * the media path: live, playback, vod, export, discovery, connection_test) and logs every read in vault_reads (never the value).
 */
export type CredentialPurpose = 'monitoring' | 'discovery' | 'connection_test' | 'live' | 'playback' | 'vod' | 'export'

/**
 * The saved login of ONE recorder for ONE purpose, through the one logged server function keyed by recorder
 * (recorder_credential_read; it refuses a switched-off NVR, a role that may not read for that purpose, and — when the organisation
 * locked it — the service key). `client` must be the credential client of this process (lib/supabase/service-clients.ts
 * `createMediaClient` in the web app, the worker's own client in the worker): the web app's own role cannot read logins at all.
 * `actorId`: the person the read is for, when there is one (logged). `password` is null when none is saved. Never logged, never
 * returned to a browser.
 */
export async function readRecorderPassword(
  client: AdminClient, recorderId: string, purpose: CredentialPurpose, actorId?: string,
): Promise<{ ok: true; password: string | null } | { ok: false; code: string | undefined }> {
  const { data, error } = await client.rpc('recorder_credential_read', { p_recorder: recorderId, p_purpose: purpose, ...(actorId ? { p_actor: actorId } : {}) })
  if (error) return { ok: false, code: error.code }
  return { ok: true, password: typeof data === 'string' && data !== '' ? data : null }
}
