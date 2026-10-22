import type { SupabaseClient } from '@supabase/supabase-js'
import type { Database, Json } from '@/types/database'
import type { Capability } from '@/lib/auth/capabilities'
import { logger } from '@/lib/observability/logger'

// Best-effort audit of access-controlled operations (P2-2 brief item 7; the durable, hash-chained audit is P5 / D-15). Written to
// admin_audit_log with the service role. Records the actor, the capability used, camera / location ids and a count. Never a token, an
// address, a URL or a password: detail fields that could carry one are dropped by name and by value. A failure is logged by its kind
// only and never breaks the operation.
//
// Actions written here:
//   cctv_live_opened       capability cctv.live, cameraIds (opened), kind sub|main
//   cctv_playback_searched capability cctv.playback, cameraIds [camera], what: calendar|day, plus month or day
//   cctv_playback_opened   capability cctv.playback, cameraIds [camera], minutes
//   cctv_export_started    capability cctv.export, cameraIds [camera], minutes (fast playback / VOD)
//   cctv_export_ended      capability cctv.export, cameraIds [camera]
//   cctv_export_denied     capability cctv.export, cameraIds [camera] when well-formed, reason
//   check_requested        capability it.monitoring.operate (lib/monitor/check-now.ts)
//   cameras_discovered     capability admin.inventory (lib/monitor/discovery.ts)
//   group_*                camera groups (lib/groups/service.ts)

export type AccessAuditEntry = {
  orgId: string
  actorId: string
  action: string
  capability: Capability
  cameraIds?: string[]
  locationIds?: string[]
  detail?: Record<string, string | number | boolean | null>
}

const SECRET_NAME = /token|password|secret|passwd|url|uri|src|address|ip|host|credential|key/i
const SECRET_VALUE = /:\/\/|@|\b\d{1,3}(\.\d{1,3}){3}\b/

export async function auditAccess(admin: SupabaseClient<Database>, e: AccessAuditEntry): Promise<void> {
  try {
    const detail: Record<string, Json> = { capability: e.capability }
    if (e.cameraIds) detail.cameraIds = e.cameraIds
    if (e.locationIds) detail.locationIds = e.locationIds
    const ids = e.cameraIds ?? e.locationIds
    if (ids) detail.count = ids.length
    for (const [k, v] of Object.entries(e.detail ?? {})) {
      if (SECRET_NAME.test(k) || (typeof v === 'string' && SECRET_VALUE.test(v))) continue
      detail[k] = v
    }
    const one = e.cameraIds?.length === 1 ? { type: 'camera', id: e.cameraIds[0] } : !e.cameraIds && e.locationIds?.length === 1 ? { type: 'store', id: e.locationIds[0] } : null
    const { error } = await admin.from('admin_audit_log').insert({
      org_id: e.orgId,
      actor_id: e.actorId,
      action: e.action,
      entity_type: one?.type ?? null,
      entity_id: one?.id ?? null,
      detail,
    })
    if (error) logger.error({ event: 'access_audit_failed', action: e.action, errorCode: (error as { code?: string }).code })
  } catch (error) {
    logger.error({ event: 'access_audit_failed', action: e.action, errorName: error instanceof Error ? error.name : typeof error })
  }
}
