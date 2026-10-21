import type { SupabaseClient } from '@supabase/supabase-js'
import type { Database } from '@/types/database'
import type { Json } from '@/types/database'
import { logger } from '@/lib/observability/logger'

export type AuditEntry = {
  orgId: string
  actorId: string
  action: string
  entityType?: string
  entityId?: string
  detail?: Json
}

/** Records who did what. A failure to write the record never breaks the action itself; it is logged instead. */
export async function addAudit(admin: SupabaseClient<Database>, e: AuditEntry): Promise<void> {
  const { error } = await admin.from('admin_audit_log').insert({
    org_id: e.orgId,
    actor_id: e.actorId,
    action: e.action,
    entity_type: e.entityType ?? null,
    entity_id: e.entityId ?? null,
    detail: e.detail ?? {},
  })
  if (error) logger.error({ event: 'audit_write_failed', action: e.action, error })
}
