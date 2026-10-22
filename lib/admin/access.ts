// The access editor's server side (P2-3, WP-2.1c; directive AC-5, AC-6, AC-9, AC-12; decisions D-1, D-2a).
//
// A change is a list of explicit grants to add and grants to revoke. It is checked here (input, organisation, every scope id, who may
// grant what — lib/admin/access-rules.ts), previewed with preview_access_change, and saved in one transaction with
// apply_access_change, which checks the same rules again in the database. Saving needs the token of a preview of exactly the same
// changes at the same access version, so nothing is saved that the administrator has not seen; a change made by someone else in
// between (access_version moved) gives MSG_CONFLICT. History is never edited: revoking sets revoked_at with a reason.
// Every function here takes the service-role client and the acting administrator; the caller (lib/actions/admin/access.ts) has
// already checked the session, the administrative role and admin.access (requireAdministration).
import { createHash } from 'node:crypto'
import { z } from 'zod'
import { addAudit } from '@/lib/admin/audit'
import type { Role } from '@/lib/admin/roles'
import type { Actor, AdminClient } from '@/lib/admin/types'
import {
  areaOf,
  endOfDayIst,
  expiresSoon,
  grantRefusal,
  grantState,
  hasReason,
  istDate,
  lastDayIst,
  manageRefusal,
  OWNER_ONLY_CAPABILITIES,
  summarise,
  type CatalogueEntry,
  type GrantState,
  type Holding,
  type ScopeKind,
  type SummaryRow,
} from '@/lib/admin/access-rules'
import { sanitizeError } from '@/lib/observability/sanitize-error'
import { assertRefsInOrg } from '@/lib/security/org-scope'
import { fetchAll } from '@/lib/supabase/fetch-all'

export const MSG_CONFLICT = 'Someone else changed this person’s access while you were working. Reload the page to see their current access, then make your changes again.'
export const MSG_PREVIEW_FIRST = 'These are not the changes you checked. Check the effect again before saving.'
const MSG_NOT_FOUND_REF = 'One of the locations, cameras or assets was not found.'
const MSG_GRANT_GONE = 'One of the grants to remove was not found or has already been removed. Reload the page.'

export type AccessResult<T> = ({ ok: true } & T) | { ok: false; error: string; conflict?: true }

const DATE = /^\d{4}-\d{2}-\d{2}$/
const grantChange = z.object({
  op: z.literal('grant'),
  capability: z.string().trim().min(3).max(64),
  scope_kind: z.enum(['organization', 'location', 'camera', 'asset']),
  scope_id: z.uuid('Choose a location, camera or asset.').nullable(),
  valid_until: z.string().regex(DATE, 'Use a date like 2026-10-31.').nullable(),
  reason: z.string().trim().max(500, 'Use 500 characters or fewer for the reason.').default(''),
})
const revokeChange = z.object({
  op: z.literal('revoke'),
  grant_id: z.uuid(),
  reason: z.string().trim().max(500, 'Use 500 characters or fewer for the reason.'),
})
export const changeSchema = z.discriminatedUnion('op', [grantChange, revokeChange])
export const changesSchema = z.array(changeSchema).min(1, 'Add at least one change first.').max(5000, 'That is too many changes at once. Save in smaller steps.')
export type AccessChange = z.input<typeof changeSchema>
type ParsedChange = z.output<typeof changeSchema>

const firstIssue = (e: z.ZodError) => e.issues[0]?.message ?? 'Check the changes and try again.'

/** A grant ready for the database: the valid-until date turned into the end of that day in India. */
type NormalGrant = { op: 'grant'; capability: string; scope_kind: ScopeKind; scope_id: string | null; valid_until: string | null; reason: string }
type NormalRevoke = { op: 'revoke'; grant_id: string; reason: string }
type Normal = NormalGrant | NormalRevoke

type Target = { id: string; full_name: string; email: string; role: Role; is_active: boolean; must_reset_password: boolean; access_version: number }
type GrantRow = {
  id: string; capability: string; scope_kind: string; scope_id: string | null; valid_from: string; valid_until: string | null; revoked_at: string | null
  revoke_reason: string | null; revoked_by: string | null; granted_by: string | null; granted_at: string; reason: string | null; source: string; needs_review: boolean
}
const GRANT_COLUMNS = 'id, capability, scope_kind, scope_id, valid_from, valid_until, revoked_at, revoke_reason, revoked_by, granted_by, granted_at, reason, source, needs_review'

async function loadTarget(admin: AdminClient, orgId: string, userId: string): Promise<Target | null> {
  if (!z.uuid().safeParse(userId).success) return null
  const { data } = await admin.from('profiles').select('id, full_name, email, role, is_active, must_reset_password, access_version').eq('id', userId).eq('org_id', orgId).maybeSingle()
  return data ? { ...data, access_version: Number(data.access_version) } : null
}

// The catalogue's descriptions, without references to design decisions ("…, D-6a)") that mean nothing to an administrator.
const plainWords = (d: string) => d.replace(/,\s*D-\d+[a-z]?\)/, ')').replace(/\s*\(D-\d+[a-z]?\)/, '')
const CCTV_ORDER = ['cctv.live', 'cctv.playback', 'cctv.export']
const rank = (k: string) => (CCTV_ORDER.includes(k) ? CCTV_ORDER.indexOf(k) : 10)

async function catalogue(admin: AdminClient): Promise<CatalogueEntry[]> {
  const { data, error } = await admin.from('capabilities').select('key, area, risk, description, scope_kinds').order('key')
  if (error) throw new Error('Could not read the list of rights.')
  return (data ?? []).map((c) => ({ ...c, description: plainWords(c.description) })).sort((a, b) => rank(a.key) - rank(b.key) || a.key.localeCompare(b.key))
}

/** The acting administrator's live grants (what they may give on, rules 4 and 5). */
async function holdingsOf(admin: AdminClient, actor: Actor): Promise<Holding[]> {
  const rows = await fetchAll((from, to) =>
    admin.from('access_grants').select('capability, scope_kind, scope_id, valid_from, valid_until').eq('org_id', actor.orgId).eq('user_id', actor.id).is('revoked_at', null).order('id').range(from, to),
  )
  return rows as Holding[]
}

const CHUNK = 200
async function readIn<T>(ids: string[], read: (chunk: string[]) => PromiseLike<{ data: T[] | null; error: unknown }>): Promise<T[]> {
  const out: T[] = []
  const unique = [...new Set(ids)]
  for (let i = 0; i < unique.length; i += CHUNK) {
    const { data, error } = await read(unique.slice(i, i + CHUNK))
    if (error) throw new Error('Could not read the access list.')
    out.push(...(data ?? []))
  }
  return out
}

/** Labels for scope ids: "E1 · Store one", "E1 · Camera 3", "Back-office PC · E1". Only rows of the organisation. */
async function scopeLabels(admin: AdminClient, orgId: string, refs: { scope_kind: string; scope_id: string | null }[]) {
  const ids = (k: string) => refs.filter((r) => r.scope_kind === k && r.scope_id).map((r) => r.scope_id as string)
  const [stores, cameras, devices] = await Promise.all([
    readIn(ids('location'), (c) => admin.from('stores').select('id, code, name').eq('org_id', orgId).in('id', c)),
    readIn(ids('camera'), (c) => admin.from('cameras').select('id, name, store_id, stores(code)').eq('org_id', orgId).in('id', c)),
    readIn(ids('asset'), (c) => admin.from('devices').select('id, name, store_id, stores(code)').eq('org_id', orgId).in('id', c)),
  ])
  const code = (x: unknown) => (x as { code: string } | null)?.code ?? ''
  const label = new Map<string, string>([
    ...stores.map((s) => [s.id, `${s.code} · ${s.name}`] as [string, string]),
    ...cameras.map((c) => [c.id, `${code(c.stores)} · ${c.name}`] as [string, string]),
    ...devices.map((d) => [d.id, d.store_id ? `${d.name} · ${code(d.stores)}` : d.name] as [string, string]),
  ])
  return (kind: string, id: string | null) => (kind === 'organization' ? 'Whole organisation' : (id && label.get(id)) || 'No longer exists')
}

type Checked = { target: Target; normal: Normal[]; cat: Map<string, CatalogueEntry>; live: GrantRow[]; label: (kind: string, id: string | null) => string }

/** Everything a change must satisfy before it reaches the database. */
async function checkChanges(admin: AdminClient, actor: Actor, userId: string, input: unknown, now: Date): Promise<AccessResult<Checked>> {
  const parsed = changesSchema.safeParse(input)
  if (!parsed.success) return { ok: false, error: firstIssue(parsed.error) }
  const changes: ParsedChange[] = parsed.data
  const target = await loadTarget(admin, actor.orgId, userId)
  if (!target) return { ok: false, error: 'User not found.' }
  const manage = manageRefusal({ actorRole: actor.role, actorId: actor.id, targetId: target.id, targetRole: target.role })
  if (manage) return { ok: false, error: manage }

  let cat: Map<string, CatalogueEntry>
  let live: GrantRow[]
  let holdings: Holding[]
  try {
    cat = new Map((await catalogue(admin)).map((c) => [c.key, c]))
    live = (await fetchAll((from, to) =>
      admin.from('access_grants').select(GRANT_COLUMNS).eq('org_id', actor.orgId).eq('user_id', target.id).is('revoked_at', null).order('id').range(from, to),
    )) as GrantRow[]
    holdings = await holdingsOf(admin, actor)
  } catch (e) {
    return { ok: false, error: sanitizeError(e, { route: 'access.check', fallback: 'Could not check the changes. Please try again.' }) }
  }

  const today = istDate(now)
  const normal: Normal[] = []
  const seen = new Set<string>()
  for (const c of changes) {
    if (c.op === 'revoke') {
      if (!hasReason(c.reason)) return { ok: false, error: 'Give a reason for each removal (at least three characters).' }
      if (!live.some((g) => g.id === c.grant_id)) return { ok: false, error: MSG_GRANT_GONE }
      if (seen.has(`r:${c.grant_id}`)) continue
      seen.add(`r:${c.grant_id}`)
      normal.push({ op: 'revoke', grant_id: c.grant_id, reason: c.reason })
      continue
    }
    const cap = cat.get(c.capability)
    if (!cap) return { ok: false, error: 'One of the rights is not known.' }
    if (!(cap.scope_kinds ?? []).includes(c.scope_kind)) return { ok: false, error: `“${cap.description}” cannot be given for a single ${c.scope_kind === 'organization' ? 'organisation' : c.scope_kind}.` }
    if ((c.scope_kind === 'organization') !== (c.scope_id === null)) return { ok: false, error: 'Choose a location, camera or asset for each right.' }
    let validUntil: string | null = null
    if (c.valid_until) {
      try {
        validUntil = endOfDayIst(c.valid_until)
      } catch {
        return { ok: false, error: 'Use a real date for “valid until”.' }
      }
      if (c.valid_until < today) return { ok: false, error: 'The valid-until date must be today or later.' }
    }
    const key = `g:${c.capability}|${c.scope_kind}|${c.scope_id}|${validUntil}`
    if (seen.has(key)) continue
    seen.add(key)
    normal.push({ op: 'grant', capability: c.capability, scope_kind: c.scope_kind, scope_id: c.scope_id?.toLowerCase() ?? null, valid_until: validUntil, reason: c.reason })
  }

  const grants = normal.filter((n): n is NormalGrant => n.op === 'grant')
  const idsOf = (k: ScopeKind) => grants.filter((x) => x.scope_kind === k).map((x) => x.scope_id as string)
  const parent = new Map<string, string | null>()
  try {
    await assertRefsInOrg(admin, actor.orgId, [
      { table: 'stores', ids: idsOf('location') },
      { table: 'cameras', ids: idsOf('camera') },
      { table: 'devices', ids: idsOf('asset') },
    ])
    for (const c of await readIn(idsOf('camera'), (ch) => admin.from('cameras').select('id, store_id').eq('org_id', actor.orgId).in('id', ch))) parent.set(c.id, c.store_id)
    for (const d of await readIn(idsOf('asset'), (ch) => admin.from('devices').select('id, store_id').eq('org_id', actor.orgId).in('id', ch))) parent.set(d.id, d.store_id)
  } catch {
    return { ok: false, error: MSG_NOT_FOUND_REF }
  }

  for (const n of grants) {
    const refusal = grantRefusal({
      actorRole: actor.role, actorId: actor.id, targetId: target.id, targetRole: target.role, holdings, cap: cat.get(n.capability)!,
      spec: n, parentLocation: n.scope_id ? parent.get(n.scope_id) ?? null : null, reason: n.reason, now,
    })
    if (refusal) return { ok: false, error: refusal }
  }
  let label: Checked['label']
  try {
    label = await scopeLabels(admin, actor.orgId, [...grants, ...live])
  } catch (e) {
    return { ok: false, error: sanitizeError(e, { route: 'access.labels', fallback: 'Could not check the changes. Please try again.' }) }
  }
  return { ok: true, target, normal, cat, live, label }
}

/** Binds a save to the preview the administrator saw: the same person, access version and changes. A screen guarantee, not a secret. */
export function previewToken(userId: string, version: number, normal: readonly Normal[]): string {
  const canon = normal.map((n) => (n.op === 'revoke' ? ['r', n.grant_id, n.reason] : ['g', n.capability, n.scope_kind, n.scope_id, n.valid_until, n.reason]))
  return createHash('sha256').update(JSON.stringify(['drishti-access-preview-v1', userId, version, canon])).digest('hex')
}

export type PreviewCapability = {
  capability: string; label: string; target: 'camera' | 'asset' | 'location' | 'organization'
  added: number; removed: number; sampleAdded: { id: string; label: string }[]; sampleRemoved: { id: string; label: string }[]
}
export type ChangeLine =
  | { op: 'grant'; capability: string; capabilityLabel: string; scopeKind: string; scopeLabel: string; lastDay: string | null; reason: string; alreadyGiven: boolean }
  | { op: 'revoke'; grantId: string; capabilityLabel: string; scopeLabel: string; reason: string }
export type Preview = { version: number; token: string; personActive: boolean; capabilities: PreviewCapability[]; lines: ChangeLine[] }

const isConflict = (e: { code?: string } | null) => e?.code === '40001'

/** What the change would add and remove, per capability, and the exact list of grants that would be created and revoked. Writes nothing. */
export async function previewChange(admin: AdminClient, actor: Actor, userId: string, input: { changes: unknown; expectedVersion: number }, now = new Date()): Promise<AccessResult<Preview>> {
  const checked = await checkChanges(admin, actor, userId, input.changes, now)
  if (!checked.ok) return checked
  const { target, normal, cat, live, label } = checked
  if (target.access_version !== input.expectedVersion) return { ok: false, error: MSG_CONFLICT, conflict: true }
  const p_changes = normal.map((n) => (n.op === 'revoke' ? { op: 'revoke', grant_id: n.grant_id } : { op: 'grant', capability: n.capability, scope_kind: n.scope_kind, scope_id: n.scope_id, valid_until: n.valid_until }))
  const { data, error } = await admin.rpc('preview_access_change', { p_org: actor.orgId, p_user: target.id, p_changes, p_sample: 10 })
  if (error) return { ok: false, error: sanitizeError(error, { route: 'access.preview', fallback: 'Could not work out the effect. Please try again.' }) }
  const out = data as { version: number; person_active: boolean; capabilities: Record<string, { target: PreviewCapability['target']; added_count: number; removed_count: number; sample_added: { id: string; label: string }[]; sample_removed: { id: string; label: string }[] }> }
  if (Number(out.version) !== input.expectedVersion) return { ok: false, error: MSG_CONFLICT, conflict: true }
  const capabilities = Object.entries(out.capabilities ?? {})
    .map(([k, v]) => ({ capability: k, label: cat.get(k)?.description ?? k, target: v.target, added: Number(v.added_count), removed: Number(v.removed_count), sampleAdded: v.sample_added ?? [], sampleRemoved: v.sample_removed ?? [] }))
    .filter((c) => c.added > 0 || c.removed > 0 || normal.some((n) => n.op === 'grant' && n.capability === c.capability) || normal.some((n) => n.op === 'revoke' && live.find((g) => g.id === n.grant_id)?.capability === c.capability))
  const revoked = new Set(normal.filter((n) => n.op === 'revoke').map((n) => (n as NormalRevoke).grant_id))
  const lines: ChangeLine[] = normal.map((n) => {
    if (n.op === 'revoke') {
      const g = live.find((x) => x.id === n.grant_id)!
      return { op: 'revoke', grantId: n.grant_id, capabilityLabel: cat.get(g.capability)?.description ?? g.capability, scopeLabel: label(g.scope_kind, g.scope_id), reason: n.reason }
    }
    // Monotonic granting: an existing live grant of the same right and scope that already covers the window means nothing changes.
    const same = live.find((x) => !revoked.has(x.id) && x.capability === n.capability && x.scope_kind === n.scope_kind && x.scope_id === n.scope_id)
    const t = now.getTime()
    const alreadyGiven = !!same && new Date(same.valid_from).getTime() <= t && (same.valid_until === null || (n.valid_until !== null && new Date(same.valid_until).getTime() >= new Date(n.valid_until).getTime()))
    return {
      op: 'grant', capability: n.capability, capabilityLabel: cat.get(n.capability)?.description ?? n.capability, scopeKind: n.scope_kind, scopeLabel: label(n.scope_kind, n.scope_id),
      lastDay: n.valid_until ? lastDayIst(n.valid_until) : null, reason: n.reason, alreadyGiven,
    }
  })
  return { ok: true, version: input.expectedVersion, token: previewToken(target.id, input.expectedVersion, normal), personActive: out.person_active === true, capabilities, lines }
}

function dbRefusal(error: { code?: string; message: string }, route: string): string {
  if (error.code === '42501' && /own access/.test(error.message)) return 'You cannot change your own access. Ask another administrator.'
  if (error.code === '42501') return 'You are not allowed to make one of these changes. Reload the page and check what you hold yourself.'
  if (error.code === 'P0002') return MSG_GRANT_GONE
  if (error.code === '22023' && /reason required/.test(error.message)) return 'Give a reason for export, for high-risk rights and for each removal.'
  if (error.code === '22023' && /outside organisation/.test(error.message)) return MSG_NOT_FOUND_REF
  return sanitizeError(error, { route, fallback: 'Could not save the access changes. Please try again.' })
}

const auditGrants = (normal: Normal[], ids: string[]) =>
  normal.filter((n): n is NormalGrant => n.op === 'grant').slice(0, 200).map((n, i) => ({ grant_id: ids[i] ?? null, capability: n.capability, scope_kind: n.scope_kind, scope_id: n.scope_id, valid_until: n.valid_until, reason: n.reason || null }))

async function applyNormal(admin: AdminClient, actor: Actor, target: Target, normal: Normal[], expectedVersion: number, live: GrantRow[]): Promise<AccessResult<{ version: number; added: number; revoked: number }>> {
  const { data, error } = await admin.rpc('apply_access_change', { p_org: actor.orgId, p_user: target.id, p_changes: normal, p_actor: actor.id, p_expected_version: expectedVersion })
  if (error) return isConflict(error) ? { ok: false, error: MSG_CONFLICT, conflict: true } : { ok: false, error: dbRefusal(error, 'access.apply') }
  const res = data as { version: number; added: number; revoked: number; grant_ids: string[] }
  const grants = normal.filter((n) => n.op === 'grant')
  const revokes = normal.filter((n): n is NormalRevoke => n.op === 'revoke')
  if (grants.length > 0) {
    await addAudit(admin, { orgId: actor.orgId, actorId: actor.id, action: 'access_granted', entityType: 'profile', entityId: target.id, detail: { count: grants.length, added: res.added, version: res.version, grants: auditGrants(normal, res.grant_ids ?? []) } })
  }
  if (revokes.length > 0) {
    await addAudit(admin, {
      orgId: actor.orgId, actorId: actor.id, action: 'access_revoked', entityType: 'profile', entityId: target.id,
      detail: {
        count: revokes.length, version: res.version,
        grants: revokes.slice(0, 200).map((n) => {
          const g = live.find((x) => x.id === n.grant_id)
          return { grant_id: n.grant_id, capability: g?.capability ?? null, scope_kind: g?.scope_kind ?? null, scope_id: g?.scope_id ?? null, valid_until: g?.valid_until ?? null, reason: n.reason }
        }),
      },
    })
  }
  return { ok: true, version: Number(res.version), added: Number(res.added), revoked: Number(res.revoked) }
}

/** Saves a previewed change in one transaction. */
export async function applyChange(admin: AdminClient, actor: Actor, userId: string, input: { changes: unknown; expectedVersion: number; token: string }, now = new Date()): Promise<AccessResult<{ version: number; added: number; revoked: number }>> {
  const checked = await checkChanges(admin, actor, userId, input.changes, now)
  if (!checked.ok) return checked
  if (typeof input.token !== 'string' || input.token !== previewToken(checked.target.id, input.expectedVersion, checked.normal)) return { ok: false, error: MSG_PREVIEW_FIRST }
  if (checked.target.access_version !== input.expectedVersion) return { ok: false, error: MSG_CONFLICT, conflict: true }
  return applyNormal(admin, actor, checked.target, checked.normal, input.expectedVersion, checked.live)
}

/**
 * Revokes exactly the listed live grants with one reason (used when reactivating a person, after the administrator has seen the list —
 * that list is the preview). expectedVersion is the version the list was read at.
 */
export async function revokeAll(admin: AdminClient, actor: Actor, userId: string, input: { grantIds: string[]; reason: string; expectedVersion: number }, now = new Date()) {
  if (!Array.isArray(input.grantIds) || input.grantIds.length === 0) return { ok: false as const, error: 'There is nothing to remove.' }
  const checked = await checkChanges(admin, actor, userId, input.grantIds.map((grant_id) => ({ op: 'revoke', grant_id, reason: input.reason })), now)
  if (!checked.ok) return checked
  if (checked.target.access_version !== input.expectedVersion) return { ok: false as const, error: MSG_CONFLICT, conflict: true as const }
  return applyNormal(admin, actor, checked.target, checked.normal, input.expectedVersion, checked.live)
}

// ── Reading ─────────────────────────────────────────────────────────────────
export type GrantView = {
  id: string; capability: string; capabilityLabel: string; area: string; risk: string; scopeKind: string; scopeId: string | null; scopeLabel: string
  source: string; needsReview: boolean; validFrom: string; validUntil: string | null; lastDay: string | null; grantedAt: string; grantedByName: string | null
  reason: string | null; revokedAt: string | null; revokedByName: string | null; revokeReason: string | null; state: GrantState; expiresSoon: boolean; keptAt: string | null
}

async function peopleNames(admin: AdminClient, orgId: string, ids: (string | null)[]) {
  const rows = await readIn(ids.filter((x): x is string => !!x), (c) => admin.from('profiles').select('id, full_name, email').eq('org_id', orgId).in('id', c))
  return new Map(rows.map((p) => [p.id, p.full_name || p.email]))
}

function toViews(rows: GrantRow[], cat: Map<string, CatalogueEntry>, label: (k: string, id: string | null) => string, names: Map<string, string>, kept: Map<string, string>, now: Date): GrantView[] {
  return rows.map((g) => {
    const c = cat.get(g.capability)
    return {
      id: g.id, capability: g.capability, capabilityLabel: c?.description ?? g.capability, area: c?.area ?? areaOf(g.capability), risk: c?.risk ?? 'low',
      scopeKind: g.scope_kind, scopeId: g.scope_id, scopeLabel: label(g.scope_kind, g.scope_id), source: g.source, needsReview: g.needs_review,
      validFrom: g.valid_from, validUntil: g.valid_until, lastDay: g.valid_until ? lastDayIst(g.valid_until) : null, grantedAt: g.granted_at,
      grantedByName: g.granted_by ? names.get(g.granted_by) ?? null : null, reason: g.reason, revokedAt: g.revoked_at,
      revokedByName: g.revoked_by ? names.get(g.revoked_by) ?? null : null, revokeReason: g.revoke_reason, state: grantState(g, now), expiresSoon: expiresSoon(g, now),
      keptAt: kept.get(g.id) ?? null,
    }
  })
}

export type EditorData = {
  person: Omit<Target, 'access_version'>
  version: number
  editable: boolean
  notEditableReason: string | null
  grants: GrantView[]
  catalogue: CatalogueEntry[]
  /** The capabilities this administrator may offer for this person (the server checks each grant again). */
  grantable: string[]
  locations: { id: string; code: string; name: string }[]
  cameras: { id: string; store_id: string; channel: number; name: string }[]
  assets: { id: string; store_id: string | null; name: string; type: string }[]
}

const STATE_ORDER: Record<GrantState, number> = { active: 0, future: 1, expired: 2, revoked: 3 }

/** Everything the editor page shows. null when the person is not in the administrator's organisation. */
export async function loadEditor(admin: AdminClient, actor: Actor, userId: string, now = new Date()): Promise<EditorData | null> {
  const target = await loadTarget(admin, actor.orgId, userId)
  if (!target) return null
  const [cat, rows, holdings, locations, cameras, assets, reviews] = await Promise.all([
    catalogue(admin),
    fetchAll((from, to) => admin.from('access_grants').select(GRANT_COLUMNS).eq('org_id', actor.orgId).eq('user_id', target.id).order('granted_at', { ascending: false }).order('id').range(from, to)),
    holdingsOf(admin, actor),
    fetchAll((from, to) => admin.from('stores').select('id, code, name').eq('org_id', actor.orgId).order('code').order('id').range(from, to)),
    fetchAll((from, to) => admin.from('cameras').select('id, store_id, channel, name').eq('org_id', actor.orgId).order('store_id').order('channel').order('id').range(from, to)),
    fetchAll((from, to) => admin.from('devices').select('id, store_id, name, type').eq('org_id', actor.orgId).order('name').order('id').range(from, to)),
    fetchAll((from, to) => admin.from('access_grant_reviews').select('grant_id, reviewed_at').eq('org_id', actor.orgId).order('id').range(from, to)),
  ])
  const grantRows = rows as GrantRow[]
  const label = await scopeLabels(admin, actor.orgId, grantRows)
  const names = await peopleNames(admin, actor.orgId, grantRows.flatMap((g) => [g.granted_by, g.revoked_by]))
  const kept = new Map(reviews.map((r) => [r.grant_id, r.reviewed_at]))
  const grants = toViews(grantRows, new Map(cat.map((c) => [c.key, c])), label, names, kept, now).sort((a, b) => STATE_ORDER[a.state] - STATE_ORDER[b.state])
  const notEditableReason = manageRefusal({ actorRole: actor.role, actorId: actor.id, targetId: target.id, targetRole: target.role })
  const t = now.getTime()
  const held = new Set(holdings.filter((h) => new Date(h.valid_from).getTime() <= t && (h.valid_until === null || new Date(h.valid_until).getTime() > t)).map((h) => h.capability))
  const adminTarget = target.role === 'admin' || target.role === 'platform_owner'
  const grantable = cat
    .map((c) => c.key)
    .filter((k) => (areaOf(k) !== 'admin' || adminTarget) && (actor.role === 'platform_owner' || (held.has(k) && !(OWNER_ONLY_CAPABILITIES as readonly string[]).includes(k))))
  const { access_version, ...person } = target
  return { person, version: access_version, editable: notEditableReason === null, notEditableReason, grants, catalogue: cat, grantable, locations, cameras, assets }
}

// ── Review of migrated grants (D-2a) ─────────────────────────────────────────
export const REVIEW_SOURCES = ['migrated:home', 'migrated:manager', 'migrated:admin'] as const
export type ReviewItem = GrantView & { grantId: string; userId: string; personName: string; personEmail: string; personRole: string; personActive: boolean }
export type ReviewNote = { userId: string; personName: string; note: string; lostDevices: boolean; createdAt: string }
export type ReviewData = { open: ReviewItem[]; kept: ReviewItem[]; notes: ReviewNote[]; openCount: number }

export async function listReview(admin: AdminClient, orgId: string, now = new Date()): Promise<ReviewData> {
  const cols = `${GRANT_COLUMNS}, user_id`
  const [bySource, flagged, reviews, people, reports, cat] = await Promise.all([
    fetchAll((from, to) => admin.from('access_grants').select(cols).eq('org_id', orgId).is('revoked_at', null).in('source', [...REVIEW_SOURCES]).order('id').range(from, to)),
    fetchAll((from, to) => admin.from('access_grants').select(cols).eq('org_id', orgId).is('revoked_at', null).eq('needs_review', true).order('id').range(from, to)),
    fetchAll((from, to) => admin.from('access_grant_reviews').select('grant_id, reviewed_at').eq('org_id', orgId).order('id').range(from, to)),
    fetchAll((from, to) => admin.from('profiles').select('id, full_name, email, role, is_active').eq('org_id', orgId).order('id').range(from, to)),
    fetchAll((from, to) => admin.from('access_migration_report').select('user_id, note, created_at').eq('org_id', orgId).not('note', 'is', null).order('created_at', { ascending: false }).order('id').range(from, to)),
    catalogue(admin),
  ])
  const rows = [...new Map([...bySource, ...flagged].map((g) => [g.id, g as GrantRow & { user_id: string }])).values()]
  const label = await scopeLabels(admin, orgId, rows)
  const person = new Map(people.map((p) => [p.id, p]))
  const names = new Map(people.map((p) => [p.id, p.full_name || p.email]))
  const kept = new Map(reviews.map((r) => [r.grant_id, r.reviewed_at]))
  const views = toViews(rows, new Map(cat.map((c) => [c.key, c])), label, names, kept, now)
  const items: ReviewItem[] = views.map((v, i) => {
    const p = person.get(rows[i].user_id)
    return { ...v, grantId: v.id, userId: rows[i].user_id, personName: p?.full_name || p?.email || 'Person no longer exists', personEmail: p?.email ?? '', personRole: p?.role ?? '', personActive: p?.is_active ?? false }
  }).sort((a, b) => a.personName.localeCompare(b.personName) || a.capability.localeCompare(b.capability) || a.scopeLabel.localeCompare(b.scopeLabel))
  const latest = new Map<string, { user_id: string; note: string | null; created_at: string }>()
  for (const r of reports) if (!latest.has(r.user_id)) latest.set(r.user_id, r)
  const notes: ReviewNote[] = [...latest.values()]
    .filter((r) => r.note)
    .map((r) => ({ userId: r.user_id, personName: names.get(r.user_id) ?? 'Person no longer exists', note: r.note as string, lostDevices: /IT devices no longer visible/.test(r.note ?? ''), createdAt: r.created_at }))
    .sort((a, b) => Number(b.lostDevices) - Number(a.lostDevices) || a.personName.localeCompare(b.personName))
  const open = items.filter((x) => !x.keptAt)
  return { open, kept: items.filter((x) => !!x.keptAt), notes, openCount: open.length }
}

export const keepSchema = z.object({
  grantIds: z.array(z.uuid()).min(1, 'Choose at least one grant.').max(1000),
  note: z.string().trim().max(500, 'Use 500 characters or fewer for the note.').nullable().optional(),
})

/** "Keep (confirm)": records that an administrator reviewed and kept these migrated grants. */
export async function keepReviewed(admin: AdminClient, actor: Actor, input: unknown): Promise<AccessResult<{ kept: number }>> {
  const parsed = keepSchema.safeParse(input)
  if (!parsed.success) return { ok: false, error: firstIssue(parsed.error) }
  const note = parsed.data.note || null
  const { data, error } = await admin.rpc('access_review_keep', { p_org: actor.orgId, p_actor: actor.id, p_grant_ids: parsed.data.grantIds, p_note: note ?? undefined })
  if (error) {
    if (error.code === '42501' && /own access/.test(error.message)) return { ok: false, error: 'You cannot confirm your own access. Ask another administrator.' }
    if (error.code === '42501') return { ok: false, error: 'You are not allowed to confirm one of these grants.' }
    if (error.code === 'P0002') return { ok: false, error: 'One of these grants is no longer waiting for review. Reload the page.' }
    return { ok: false, error: sanitizeError(error, { route: 'access.keep', fallback: 'Could not record the review. Please try again.' }) }
  }
  const kept = Number(data ?? 0)
  await addAudit(admin, { orgId: actor.orgId, actorId: actor.id, action: 'access_review_kept', entityType: 'access_grant', detail: { grant_ids: parsed.data.grantIds.slice(0, 200), count: kept, note } })
  return { ok: true, kept }
}

// ── People list ─────────────────────────────────────────────────────────────
/** userId → "Live: 3 locations, Playback: 3 locations, IT: none" (what is in effect now; access_grant_summary). */
export async function accessSummaries(admin: AdminClient, orgId: string): Promise<Map<string, string>> {
  const { data, error } = await admin.rpc('access_grant_summary', { p_org: orgId })
  if (error) throw new Error('Could not read the access summary.')
  const by = new Map<string, SummaryRow[]>()
  for (const r of data ?? []) {
    const list = by.get(r.user_id) ?? []
    list.push({ capability: r.capability, organization_wide: r.organization_wide, locations: r.locations, cameras: r.cameras, assets: r.assets })
    by.set(r.user_id, list)
  }
  return new Map([...by].map(([u, rows]) => [u, summarise(rows)]))
}

/** The live grants of a person and their access version: shown before reactivating them (brief item: review old grants). */
export async function liveGrantsOf(admin: AdminClient, orgId: string, userId: string, now = new Date()): Promise<{ version: number; grants: GrantView[] } | null> {
  const target = await loadTarget(admin, orgId, userId)
  if (!target) return null
  const [cat, rows] = await Promise.all([
    catalogue(admin),
    fetchAll((from, to) => admin.from('access_grants').select(GRANT_COLUMNS).eq('org_id', orgId).eq('user_id', target.id).is('revoked_at', null).order('capability').order('id').range(from, to)),
  ])
  const label = await scopeLabels(admin, orgId, rows as GrantRow[])
  const names = await peopleNames(admin, orgId, (rows as GrantRow[]).map((g) => g.granted_by))
  return { version: target.access_version, grants: toViews(rows as GrantRow[], new Map(cat.map((c) => [c.key, c])), label, names, new Map(), now) }
}
