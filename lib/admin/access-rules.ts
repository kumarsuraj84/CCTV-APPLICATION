// Pure rules of the access editor (P2-3, decision D-1; docs/drishti/access-model.md "Who may grant what"). No server imports: the
// editor (a client component) uses the same functions to explain things before the Server Action checks them again, and the database
// checks them a third time (migration 20261021000015: access_check_manager, access_check_grantor).
import type { Role } from '@/lib/admin/roles'

// P2-5a (ruling C-1): region, cluster and recorder scopes. The editor offers them from P2-5c; the rules below already know them.
export type ScopeKind = 'organization' | 'region' | 'cluster' | 'location' | 'recorder' | 'camera' | 'asset'
/** Where a grant target sits in the tree (archived nodes cut out), from the database (access_target_ancestry). */
export type Ancestry = { region_id: string | null; cluster_id: string | null; location_id: string | null; recorder_id: string | null }
export type Area = 'cctv' | 'it' | 'wifi' | 'admin'
export type CatalogueEntry = { key: string; area: Area | string; risk: 'low' | 'medium' | 'high' | string; description: string; scope_kinds?: string[] }

/** Given only by a platform owner (brief item 6: the ruling recorded in docs/drishti/access-model.md). */
// wifi.credentials.admin added in the P2-3 review (ruling M-9: symmetric with it.credentials.admin). Same list in SQL: access_owner_only().
export const OWNER_ONLY_CAPABILITIES = [
  'it.os.deploy', 'it.credentials.admin', 'it.remote.control', 'it.script.run', 'it.software.manage', 'it.config.deploy', 'it.patch.manage',
  'wifi.credentials.admin',
] as const

/** Owner ruling E-1: downloads (cctv.export) only for administrators and super administrators. */
export const MSG_EXPORT_ADMINS_ONLY = 'Download rights (export) can only be given to administrators and super administrators.'
export const isAdministrativeRole = (r: Role) => r === 'admin' || r === 'platform_owner'
/** May a person with this role hold the capability at all (E-1 for export, rule 7 for admin.*)? */
export const roleMayHold = (role: Role, capability: string) =>
  isAdministrativeRole(role) || !(capability === 'cctv.export' || capability.startsWith('admin.'))

/** The administrator set: exactly what the migration (migrated:admin), the dev-admin script and the demo give administrators. */
export const ADMINISTRATOR_SET = [
  'cctv.live', 'cctv.playback', 'cctv.export', 'it.inventory.view', 'it.monitoring.view', 'it.monitoring.operate', 'wifi.inventory.view',
  'wifi.config.view_redacted', 'admin.users', 'admin.access', 'admin.inventory', 'admin.alerts', 'admin.audit.read',
] as const

/**
 * Presets only fill in the editor: they expand into explicit grants, one per capability and scope, and are never stored as roles
 * (D-1). `organisationWide` presets grant for the whole organisation; the others for the locations the administrator chooses.
 */
export type Preset = {
  id: string; label: string; help: string; capabilities: readonly string[]; organisationWide: boolean; forRoles?: readonly Role[]
  /** Every capability of the catalogue (read at run time, so capabilities added later are included). */
  allCapabilities?: true
}
export const PRESETS: readonly Preset[] = [
  {
    id: 'full-rights', label: 'Full rights (all capabilities)', organisationWide: true, forRoles: ['platform_owner'], capabilities: [], allCapabilities: true,
    help: 'A super administrator holds every right for the whole organisation (owner ruling P-1). This gives back anything that was removed.',
  },
  // The brief calls this "Store CCTV viewer"; the product word is now "location" (owner instruction, 2026-10-22).
  { id: 'store-viewer', label: 'Location CCTV viewer', help: 'Live video and recordings for the locations you choose.', capabilities: ['cctv.live', 'cctv.playback'], organisationWide: false },
  { id: 'store-it-viewer', label: 'Location IT viewer', help: 'IT assets and their monitoring status for the locations you choose.', capabilities: ['it.inventory.view', 'it.monitoring.view'], organisationWide: false },
  {
    id: 'administrator-set', label: 'Administrator set', organisationWide: true, forRoles: ['admin', 'platform_owner'], capabilities: ADMINISTRATOR_SET,
    help: 'Everything an administrator needs for the whole organisation: live, playback and export, IT and Wi-Fi viewing, checks, and the five administration rights. It does not include remote control, scripts, software, configuration, patching, credentials or operating-system deployment.',
  },
]

/** One grant to add, as the editor sends it (valid_until is a day in India, "YYYY-MM-DD", or null for no end). */
export type GrantChangeInput = { op: 'grant'; capability: string; scope_kind: ScopeKind; scope_id: string | null; valid_until: string | null; reason: string }
export type RevokeChangeInput = { op: 'revoke'; grant_id: string; reason: string }
export type ChangeInput = GrantChangeInput | RevokeChangeInput

/** Expands a preset into explicit grants: organisation-wide, or one per capability and chosen location. Only grantable capabilities. */
export function presetChanges(p: Preset, o: { locations: readonly string[]; catalogue: readonly CatalogueEntry[]; grantable: readonly string[]; validUntil: string | null; reason: string }): GrantChangeInput[] {
  const caps = (p.allCapabilities ? o.catalogue.filter((c) => (c.scope_kinds ?? ['organization']).includes('organization')).map((c) => c.key) : [...p.capabilities])
    .filter((k) => o.grantable.includes(k))
  const base = { op: 'grant' as const, valid_until: o.validUntil, reason: o.reason }
  if (p.organisationWide) return caps.map((capability) => ({ ...base, capability, scope_kind: 'organization' as const, scope_id: null }))
  return caps.flatMap((capability) => o.locations.map((id) => ({ ...base, capability, scope_kind: 'location' as const, scope_id: id })))
}

/** A row of the coverage × capability matrix: one place (organisation, location, camera or asset) and the rights ticked for it. */
export type MatrixRow = { scope_kind: ScopeKind; scope_id: string | null; capabilities: readonly string[] }
/** The matrix as explicit grants: one per ticked cell. */
export function matrixChanges(rows: readonly MatrixRow[], validUntil: string | null, reason: string): GrantChangeInput[] {
  return rows.flatMap((r) => r.capabilities.map((capability) => ({ op: 'grant' as const, capability, scope_kind: r.scope_kind, scope_id: r.scope_id, valid_until: validUntil, reason })))
}

export const EXPIRES_SOON_DAYS = 7
const IST_OFFSET_MS = 330 * 60_000

/** "YYYY-MM-DD" (a day in India) → the moment that day ends (midnight IST), as an ISO string. Grants end exclusively at valid_until. */
export function endOfDayIst(date: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date)
  if (!m) throw new Error('Not a date.')
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])]
  const utc = Date.UTC(y, mo - 1, d)
  const back = new Date(utc)
  if (back.getUTCFullYear() !== y || back.getUTCMonth() !== mo - 1 || back.getUTCDate() !== d) throw new Error('Not a date.')
  return new Date(utc + 86_400_000 - IST_OFFSET_MS).toISOString()
}

/** The calendar day in India of a moment, "YYYY-MM-DD". */
export function istDate(value: Date | string): string {
  return new Date(new Date(value).getTime() + IST_OFFSET_MS).toISOString().slice(0, 10)
}

/** The last day a grant counts, in India ("valid until 25 Oct" = it stops at midnight after 25 Oct). */
export const lastDayIst = (validUntil: string): string => istDate(new Date(new Date(validUntil).getTime() - 1))

export type GrantTimes = { valid_from: string; valid_until: string | null; revoked_at: string | null }
export type GrantState = 'active' | 'future' | 'expired' | 'revoked'

export function grantState(g: GrantTimes, now: Date = new Date()): GrantState {
  const t = now.getTime()
  if (g.revoked_at) return 'revoked'
  if (new Date(g.valid_from).getTime() > t) return 'future'
  if (g.valid_until && new Date(g.valid_until).getTime() <= t) return 'expired'
  return 'active'
}

/** In effect now and ends within EXPIRES_SOON_DAYS. */
export function expiresSoon(g: GrantTimes, now: Date = new Date(), days = EXPIRES_SOON_DAYS): boolean {
  if (grantState(g, now) !== 'active' || !g.valid_until) return false
  return new Date(g.valid_until).getTime() - now.getTime() <= days * 86_400_000
}

export const reasonRequired = (cap: Pick<CatalogueEntry, 'key' | 'risk'>): boolean => cap.risk === 'high' || cap.key === 'cctv.export'
export const hasReason = (reason: string | null | undefined): boolean => (reason ?? '').trim().length >= 3
export const areaOf = (capability: string): Area => capability.split('.')[0] as Area

/** A grant the acting administrator holds (live, not revoked). */
export type Holding = { capability: string; scope_kind: ScopeKind; scope_id: string | null; valid_from: string; valid_until: string | null }
export type WantedGrant = { capability: string; scope_kind: ScopeKind; scope_id: string | null; valid_until: string | null }

export const MSG_OWN_ACCESS = 'You cannot change your own access. Ask another administrator.'
export const MSG_NOT_MANAGEABLE = 'You are not allowed to change this person’s access.'

/** Rules 1-3 for one person: may this administrator change their access at all? null = yes. */
export function manageRefusal(i: { actorRole: Role; actorId: string; targetId: string; targetRole: Role }): string | null {
  if (i.actorId === i.targetId) return MSG_OWN_ACCESS
  if (i.actorRole === 'platform_owner') return null
  if (i.actorRole === 'admin' && (i.targetRole === 'user' || i.targetRole === 'operator' || i.targetRole === 'manager')) return null
  return MSG_NOT_MANAGEABLE
}

/**
 * Rules 4-7 for one grant (the same as access_check_grantor). `parentLocation` is the location of the camera or asset, when the grant
 * points at one; `ancestry` (P2-5a) is where the target sits in the tree (organisation > region > cluster > location > recorder >
 * camera / asset): a holding at a node above the target covers it. null = allowed; otherwise a plain sentence for the administrator.
 */
export function grantRefusal(i: {
  actorRole: Role; actorId: string; targetId: string; targetRole: Role; holdings: readonly Holding[]; cap: CatalogueEntry
  spec: WantedGrant; parentLocation: string | null; ancestry?: Ancestry | null; reason: string | null | undefined; now?: Date
}): string | null {
  const manage = manageRefusal(i)
  if (manage) return manage
  const label = `“${i.cap.description}”`
  if (reasonRequired(i.cap) && !hasReason(i.reason)) return `Give a reason for ${label} (at least three characters).`
  if (areaOf(i.cap.key) === 'admin' && i.targetRole !== 'admin' && i.targetRole !== 'platform_owner') return 'Administration rights can only be given to administrators.'
  if (i.cap.key === 'cctv.export' && !isAdministrativeRole(i.targetRole)) return MSG_EXPORT_ADMINS_ONLY
  if (i.actorRole === 'platform_owner') return null
  if ((OWNER_ONLY_CAPABILITIES as readonly string[]).includes(i.cap.key)) return `Only a super administrator can give ${label}.`
  const t = (i.now ?? new Date()).getTime()
  const inEffect = i.holdings.filter(
    (h) => h.capability === i.spec.capability && new Date(h.valid_from).getTime() <= t && (h.valid_until === null || new Date(h.valid_until).getTime() > t),
  )
  const a = i.ancestry ?? null
  const covers = (h: Holding) =>
    h.scope_kind === 'organization' ||
    (h.scope_kind === i.spec.scope_kind && h.scope_id === i.spec.scope_id) ||
    (h.scope_kind === 'location' && (i.spec.scope_kind === 'camera' || i.spec.scope_kind === 'asset') && i.parentLocation !== null && h.scope_id === i.parentLocation) ||
    (a !== null && h.scope_id !== null && (
      (h.scope_kind === 'region' && a.region_id === h.scope_id) ||
      (h.scope_kind === 'cluster' && a.cluster_id === h.scope_id) ||
      (h.scope_kind === 'location' && a.location_id === h.scope_id) ||
      (h.scope_kind === 'recorder' && a.recorder_id === h.scope_id)))
  const wide = inEffect.filter(covers)
  if (wide.length === 0) return `You can only give rights you hold yourself, for the same places: ${label}.`
  const long = wide.some((h) => h.valid_until === null || (i.spec.valid_until !== null && new Date(h.valid_until).getTime() >= new Date(i.spec.valid_until).getTime()))
  if (!long) return `You hold ${label} only for a limited time, so you can give it for no longer: choose a valid-until date no later than yours.`
  return null
}

// ── Summary for the people list ─────────────────────────────────────────────
export type SummaryRow = {
  capability: string; organization_wide: boolean; locations: number; cameras: number; assets: number
  regions?: number; clusters?: number; recorders?: number
}

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`
function coverage(r: SummaryRow): string {
  if (r.organization_wide) return 'whole organisation'
  const parts = [
    r.regions && plural(r.regions, 'region', 'regions'), r.clusters && plural(r.clusters, 'cluster', 'clusters'),
    r.locations && plural(r.locations, 'location', 'locations'), r.recorders && plural(r.recorders, 'NVR', 'NVRs'),
    r.cameras && plural(r.cameras, 'camera', 'cameras'), r.assets && plural(r.assets, 'asset', 'assets'),
  ]
  return parts.filter(Boolean).join(' + ') || 'none'
}

/** "Live: 3 locations, Playback: 3 locations, IT: none" — what is in effect now (the grants; the person's status is shown apart). */
export function summarise(rows: readonly SummaryRow[]): string {
  const by = new Map(rows.map((r) => [r.capability, r]))
  const out: string[] = []
  const cctv = (cap: string, label: string, always: boolean) => {
    const r = by.get(cap)
    if (r) out.push(`${label}: ${coverage(r)}`)
    else if (always) out.push(`${label}: none`)
  }
  cctv('cctv.live', 'Live', true)
  cctv('cctv.playback', 'Playback', true)
  cctv('cctv.export', 'Export', false)
  const area = (a: Area, label: string, always: boolean) => {
    const list = rows.filter((r) => areaOf(r.capability) === a)
    if (list.length === 0) {
      if (always) out.push(`${label}: none`)
      return
    }
    const whole = list.every((r) => r.organization_wide)
    out.push(`${label}: ${plural(list.length, 'right', 'rights')}${whole && a !== 'admin' ? ' (whole organisation)' : ''}`)
  }
  area('it', 'IT', true)
  area('wifi', 'Wi-Fi', false)
  area('admin', 'Admin', false)
  return out.join(', ')
}
