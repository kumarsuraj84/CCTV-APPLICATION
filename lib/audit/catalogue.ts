// P5.4 brief item 5: every audit action the application writes, with where it is written and a plain label for the audit page. Two
// append-only tables hold them: admin_audit_log (what people did: access, people, inventory, video, groups, imports; append-only since
// migration 20261021000041) and auth_events (sign-ins and two-step events; append-only since 20261021000034/0037).
//
// tests/unit/audit-catalogue.test.ts keeps this list honest in both directions: each action's writer file names it, and every action
// literal written in lib/, app/ or a migration is in this list. tests/integration/audit-coverage.test.ts performs the operations of
// the required categories (grants and revocations, sign-ins and failures, two-step events, video opened, NVR passwords saved, imports,
// archive and restore, merge, two-step reset) and finds each row.

export type AuditTable = 'admin_audit_log' | 'auth_events'
export type AuditCategory =
  | 'access' | 'people' | 'sign_in' | 'two_step' | 'video' | 'credentials' | 'import' | 'inventory' | 'monitoring' | 'groups' | 'security'

export type AuditAction = { action: string; table: AuditTable; category: AuditCategory; label: string; writer: string }

export const AUDIT_CATEGORY_LABELS: Record<AuditCategory, string> = {
  access: 'Access rights',
  people: 'People',
  sign_in: 'Sign-in',
  two_step: 'Two-step sign-in',
  video: 'Video viewed',
  credentials: 'NVR passwords',
  import: 'Imports',
  inventory: 'Locations, NVRs, cameras and assets',
  monitoring: 'Monitoring',
  groups: 'Camera groups',
  security: 'Security settings',
}

const A = (action: string, category: AuditCategory, label: string, writer: string): AuditAction => ({ action, table: 'admin_audit_log', category, label, writer })
const E = (action: string, category: AuditCategory, label: string, writer: string): AuditAction => ({ action, table: 'auth_events', category, label, writer })

const ACCESS = 'lib/admin/access.ts'
const USERS = 'lib/admin/users.ts'
const SESSIONS = 'lib/admin/sessions.ts'
const GROUPS = 'lib/groups/service.ts'
const MFA = 'lib/auth/mfa.ts'

export const AUDIT_ACTIONS: readonly AuditAction[] = [
  // Access rights: grants and revocations (the access editor; the super administrator's automatic grants in the database).
  A('access_granted', 'access', 'Access given', ACCESS),
  A('access_revoked', 'access', 'Access removed', ACCESS),
  A('access_review_kept', 'access', 'Reviewed access kept', ACCESS),
  A('access_review_self_confirmed', 'access', 'Own migrated access confirmed', ACCESS),
  // People.
  A('user_created', 'people', 'Person created', USERS),
  A('user_updated', 'people', 'Person changed', USERS),
  A('user_password_reset', 'people', 'One-time password given', USERS),
  A('user_signed_out_everywhere', 'people', 'Signed out everywhere by an administrator', SESSIONS),
  A('mfa_factor_reset', 'two_step', 'Two-step sign-in reset by a super administrator', SESSIONS),
  A('mfa_factor_reset_incomplete', 'two_step', 'Two-step reset not completed', SESSIONS),
  // Video viewed (lib/auth/access-audit.ts writes the rows; these files say which).
  A('cctv_live_opened', 'video', 'Live video opened', 'lib/actions/streams.ts'),
  A('cctv_playback_searched', 'video', 'Recordings searched', 'lib/actions/playback.ts'),
  A('cctv_playback_opened', 'video', 'Recording played', 'lib/actions/playback.ts'),
  A('cctv_fast_playback_started', 'video', 'Fast playback started', 'lib/streams/fast.ts'),
  A('cctv_fast_playback_ended', 'video', 'Fast playback ended', 'lib/streams/fast.ts'),
  A('cctv_fast_playback_denied', 'video', 'Fast playback refused', 'lib/streams/fast.ts'),
  A('cctv_export_started', 'video', 'Recording saved to a file', 'lib/streams/vod.ts'),
  A('cctv_export_ended', 'video', 'Saving a recording ended', 'lib/streams/vod.ts'),
  A('cctv_export_denied', 'video', 'Saving a recording refused', 'lib/streams/vod.ts'),
  // NVR passwords (write-only; never the value).
  A('recorder_password_set', 'credentials', 'NVR password saved', 'lib/inventory/recorder-admin.ts'),
  // Imports.
  A('locations_imported', 'import', 'Locations imported', 'supabase/migrations/20261021000033_p26_service_roles.sql'),
  // Release 1 (T-1 review L2): the legacy writers left the application; rows written before stay labelled. Written now only by the test
  // fixture that rebuilds the shape of the owner's data.
  A('import_stores', 'import', 'Legacy location list imported', 'tests/setup/legacy-import.ts'),
  A('import_devices', 'import', 'Device list imported', 'lib/import/apply.ts'),
  // Locations, NVRs, cameras and assets.
  A('location_created', 'inventory', 'Location created', 'lib/inventory/locations.ts'),
  A('location_updated', 'inventory', 'Location changed', 'lib/inventory/locations.ts'),
  A('network_definition_saved', 'inventory', 'Location network saved', 'lib/inventory/locations.ts'),
  A('network_definition_removed', 'inventory', 'Location network removed', 'lib/inventory/locations.ts'),
  A('region_created', 'inventory', 'Region created', 'lib/inventory/hierarchy.ts'),
  A('region_updated', 'inventory', 'Region changed', 'lib/inventory/hierarchy.ts'),
  A('cluster_created', 'inventory', 'Cluster created', 'lib/inventory/hierarchy.ts'),
  A('cluster_updated', 'inventory', 'Cluster changed', 'lib/inventory/hierarchy.ts'),
  A('hierarchy_moved', 'inventory', 'Location or cluster moved', 'supabase/migrations/20261021000019_p25_locations_recorders_access.sql'),
  A('hierarchy_proposals_applied', 'inventory', 'Region and cluster proposals applied', 'supabase/migrations/20261021000027_p25c_review_fixes.sql'),
  A('recorder_created', 'inventory', 'NVR added', 'supabase/migrations/20261021000025_p25b_review_fixes.sql'),
  A('recorder_updated', 'inventory', 'NVR changed', 'supabase/migrations/20261021000025_p25b_review_fixes.sql'),
  A('recorder_monitoring_enabled', 'inventory', 'NVR monitoring switched on', 'supabase/migrations/20261021000019_p25_locations_recorders_access.sql'),
  A('recorder_monitoring_disabled', 'inventory', 'NVR monitoring switched off', 'supabase/migrations/20261021000019_p25_locations_recorders_access.sql'),
  A('recorder_connection_tested', 'inventory', 'NVR connection tested', 'lib/inventory/recorder-admin.ts'),
  // Final fix X (rulings NB-3, NB-4): "Try again" on an NVR whose login stands refused; monitoring switched for a whole scope.
  A('nvr_login_try_again', 'inventory', 'NVR login tried again (back-off ended)', 'supabase/migrations/20261021000048_fx_nvr_login_rollout.sql'),
  A('recorders_monitoring_enabled', 'inventory', 'Monitoring switched on for a region, cluster, location or everything', 'supabase/migrations/20261021000048_fx_nvr_login_rollout.sql'),
  A('recorders_monitoring_disabled', 'inventory', 'Monitoring switched off for a region, cluster, location or everything', 'supabase/migrations/20261021000048_fx_nvr_login_rollout.sql'),
  A('camera_remapped', 'inventory', 'Camera moved to another NVR or channel', 'supabase/migrations/20261021000022_p25_review_fixes.sql'),
  A('camera_merged', 'inventory', 'Duplicate camera merged', 'supabase/migrations/20261021000027_p25c_review_fixes.sql'),
  A('inventory_archived', 'inventory', 'Archived', 'supabase/migrations/20261021000024_p25b_contract.sql'),
  A('inventory_restored', 'inventory', 'Restored from the archive', 'supabase/migrations/20261021000022_p25_review_fixes.sql'),
  A('discovery_finding_settled', 'inventory', 'Discovery finding settled', 'lib/inventory/findings.ts'),
  A('asset_created', 'inventory', 'Asset created', 'lib/inventory/assets.ts'),
  A('asset_updated', 'inventory', 'Asset changed', 'lib/inventory/assets.ts'),
  A('asset_dependency_added', 'inventory', 'Asset dependency added', 'lib/inventory/assets.ts'),
  A('asset_dependency_removed', 'inventory', 'Asset dependency removed', 'lib/inventory/assets.ts'),
  A('asset_endpoint_added', 'inventory', 'Asset address added', 'lib/inventory/assets.ts'),
  A('asset_endpoint_retired', 'inventory', 'Asset address retired', 'lib/inventory/assets.ts'),
  A('device_created', 'inventory', 'Device created', 'lib/inventory/devices.ts'),
  A('device_updated', 'inventory', 'Device changed', 'lib/inventory/devices.ts'),
  A('device_deleted', 'inventory', 'Device archived', 'lib/inventory/devices.ts'),
  A('store_created', 'inventory', 'Location created (legacy form)', 'tests/setup/legacy-import.ts'),
  A('store_updated', 'inventory', 'Location changed (legacy form)', 'tests/setup/legacy-import.ts'),
  A('store_deleted', 'inventory', 'Location archived (legacy form)', 'tests/setup/legacy-import.ts'),
  // Monitoring.
  A('check_requested', 'monitoring', 'Check now asked for', 'lib/monitor/check-now.ts'),
  A('cameras_discovered', 'monitoring', 'Cameras found on an NVR', 'supabase/migrations/20261021000026_p25c_admin.sql'),
  A('discover_all_started', 'monitoring', 'Find cameras for all locations started', 'lib/inventory/discover-all.ts'),
  A('discover_all_finished', 'monitoring', 'Find cameras for all locations finished', 'lib/inventory/discover-all.ts'),
  A('discover_all_stopped', 'monitoring', 'Find cameras for all locations stopped', 'lib/inventory/discover-all.ts'),
  // Camera groups.
  A('group_created', 'groups', 'Group created', GROUPS),
  A('group_renamed', 'groups', 'Group renamed', GROUPS),
  A('group_deleted', 'groups', 'Group deleted', GROUPS),
  A('group_cameras_added', 'groups', 'Cameras added to a group', GROUPS),
  A('group_cameras_added_by_keyword', 'groups', 'Cameras added to a group by name', GROUPS),
  A('group_camera_removed', 'groups', 'Camera removed from a group', GROUPS),
  A('group_rule_added', 'groups', 'Group rule added', GROUPS),
  A('group_rule_removed', 'groups', 'Group rule removed', GROUPS),
  // Security settings (written by the database when the owner changes them).
  A('mfa_enforced_changed', 'security', 'Two-step sign-in requirement switched', 'supabase/migrations/20261021000037_p31_review_fixes.sql'),
  // Release 1 (P3-1 re-review N-4): the owner deleted an organisation's security settings row (the defaults apply again).
  A('security_settings_deleted', 'security', 'Security settings removed (defaults apply again)', 'supabase/migrations/20261021000044_release1_cleanups.sql'),
  // Sign-in events (auth_events).
  E('sign_in', 'sign_in', 'Signed in', 'lib/actions/auth.ts'),
  E('sign_in_failed', 'sign_in', 'Sign-in failed', 'lib/actions/auth.ts'),
  E('sign_out', 'sign_in', 'Signed out', 'lib/actions/auth.ts'),
  E('sign_out_everywhere', 'sign_in', 'Signed out everywhere', SESSIONS),
  E('session_expired_idle', 'sign_in', 'Signed out after being idle', 'proxy.ts'),
  E('session_expired_absolute', 'sign_in', 'Signed out at the end of the sign-in lifetime', 'proxy.ts'),
  E('mfa_enrolled', 'two_step', 'Authenticator app set up', MFA),
  E('mfa_verified', 'two_step', 'Two-step code accepted', MFA),
  E('mfa_failed', 'two_step', 'Two-step code refused', MFA),
  E('mfa_removed', 'two_step', 'Authenticator app removed', MFA),
  E('mfa_factor_reset', 'two_step', 'Authenticator app reset by a super administrator', SESSIONS),
  E('reauth', 'sign_in', 'Identity confirmed', MFA),
  E('reauth_failed', 'sign_in', 'Identity confirmation failed', MFA),
]

/** The plain label of an action, or the action itself when it is not catalogued (an old row). */
export function auditLabel(table: AuditTable, action: string): string {
  return AUDIT_ACTIONS.find((a) => a.table === table && a.action === action)?.label ?? action
}
