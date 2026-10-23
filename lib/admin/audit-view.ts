import type { SupabaseClient } from '@supabase/supabase-js'
import { AUDIT_ACTIONS, AUDIT_CATEGORY_LABELS, auditLabel, type AuditCategory } from '@/lib/audit/catalogue'
import type { Database } from '@/types/database'

// P5.4 brief item 5: the audit page (/admin/audit) — what people did (admin_audit_log) and sign-in events (auth_events), newest first,
// with filters (kind of event, category, one action, a person, a day range in India time) and a search. The rows are read through the
// signed-in person's OWN client, so the database decides (RLS: their organisation and admin.audit.read); names come from the web
// app's role, for this organisation only. Every filter value is checked here before it reaches a query.

export type AuditKind = 'actions' | 'sign_ins'
export type AuditFilters = {
  kind: AuditKind
  category: AuditCategory | null
  action: string | null
  person: string | null
  from: string | null
  to: string | null
  q: string | null
  page: number
}
export type AuditRow = { id: string; at: string; who: string; what: string; action: string; target: string; detail: string }
export type AuditPage = { rows: AuditRow[]; hasMore: boolean } | { error: string }

export const AUDIT_PAGE_SIZE = 50
const DAY = /^\d{4}-\d{2}-\d{2}$/
const one = (v: string | string[] | undefined): string => (Array.isArray(v) ? v[0] ?? '' : v ?? '').trim()

/** The filters of the page's address, every value checked (an unknown or malformed one is simply ignored). */
export function parseAuditFilters(sp: Record<string, string | string[] | undefined>): AuditFilters {
  const kind: AuditKind = one(sp.kind) === 'sign_ins' ? 'sign_ins' : 'actions'
  const table = kind === 'sign_ins' ? 'auth_events' : 'admin_audit_log'
  const cat = one(sp.category)
  const category = (Object.keys(AUDIT_CATEGORY_LABELS) as AuditCategory[]).includes(cat as AuditCategory) ? (cat as AuditCategory) : null
  const act = one(sp.action)
  const action = AUDIT_ACTIONS.some((a) => a.table === table && a.action === act) ? act : null
  // A person: part of a name or e-mail address. Letters, digits and . @ _ - and spaces only, at most 80 characters.
  const p = one(sp.person).slice(0, 80)
  const person = p.length >= 2 && /^[\p{L}\p{N} .@_'-]+$/u.test(p) ? p : null
  const day = (v: string) => (DAY.test(v) && !Number.isNaN(Date.parse(`${v}T00:00:00+05:30`)) ? v : null)
  let from = day(one(sp.from))
  let to = day(one(sp.to))
  if (from && to && from > to) [from, to] = [to, from]
  const s = one(sp.q).toLowerCase().slice(0, 60)
  const q = s.length >= 2 && /^[a-z0-9 _.:-]+$/.test(s) ? s : null
  const n = Number(one(sp.page))
  const page = Number.isInteger(n) && n >= 0 && n <= 1000 ? n : 0
  return { kind, category, action, person, from, to, q, page }
}

/** IST day boundaries as instants: [from 00:00 IST, the day after `to` 00:00 IST). */
export function istRange(from: string | null, to: string | null): { gte: string | null; lt: string | null } {
  const start = (d: string) => new Date(`${d}T00:00:00+05:30`).toISOString()
  const lt = to ? new Date(Date.parse(`${to}T00:00:00+05:30`) + 86_400_000).toISOString() : null
  return { gte: from ? start(from) : null, lt }
}

/** The address of the page with these filters (for the links), leaving out what is empty. */
export function auditHref(f: AuditFilters, change: Partial<AuditFilters> = {}): string {
  const g = { ...f, ...change }
  const p = new URLSearchParams()
  if (g.kind !== 'actions') p.set('kind', g.kind)
  for (const k of ['category', 'action', 'person', 'from', 'to', 'q'] as const) if (g[k]) p.set(k, String(g[k]))
  if (g.page > 0) p.set('page', String(g.page))
  const s = p.toString()
  return s ? `/admin/audit?${s}` : '/admin/audit'
}

function compact(detail: unknown): string {
  if (!detail || typeof detail !== 'object') return ''
  const parts: string[] = []
  for (const [k, v] of Object.entries(detail as Record<string, unknown>)) {
    const text = v === null ? 'none' : typeof v === 'object' ? (Array.isArray(v) ? `${v.length} item${v.length === 1 ? '' : 's'}` : '…') : String(v)
    parts.push(`${k}: ${text.length > 60 ? `${text.slice(0, 57)}…` : text}`)
  }
  const s = parts.join(' · ')
  return s.length > 240 ? `${s.slice(0, 237)}…` : s
}

type Client = SupabaseClient<Database>

/**
 * One page of the audit. `rls`: the person's own client (the rows); `names`: the web app's client (names of the people, this
 * organisation only). Never throws; a refused or failed read says so plainly.
 */
export async function readAuditPage(rls: Client, names: Client, orgId: string, f: AuditFilters): Promise<AuditPage> {
  let people: string[] | null = null
  if (f.person) {
    const like = `%${f.person.replace(/[%_]/g, (c) => `\\${c}`)}%`
    const { data, error } = await names.from('profiles').select('id').eq('org_id', orgId).or(`email.ilike.${JSON.stringify(like)},full_name.ilike.${JSON.stringify(like)}`).limit(200)
    if (error) return { error: 'The audit could not be read just now. Please try again.' }
    people = (data ?? []).map((r) => r.id)
    if (people.length === 0) return { rows: [], hasMore: false }
  }
  const { gte, lt } = istRange(f.from, f.to)
  const fromRow = f.page * AUDIT_PAGE_SIZE
  const toRow = fromRow + AUDIT_PAGE_SIZE // one more than a page: tells whether there is an older page

  type Raw = { id: string; at: string; actor: string | null; subject: string | null; action: string; target: string; detail: unknown }
  let raw: Raw[]
  if (f.kind === 'actions') {
    let qy = rls.from('admin_audit_log').select('id, created_at, actor_id, action, entity_type, entity_id, detail').eq('org_id', orgId)
    if (f.action) qy = qy.eq('action', f.action)
    else if (f.category) qy = qy.in('action', AUDIT_ACTIONS.filter((a) => a.table === 'admin_audit_log' && a.category === f.category).map((a) => a.action))
    if (gte) qy = qy.gte('created_at', gte)
    if (lt) qy = qy.lt('created_at', lt)
    if (people) qy = qy.or(`actor_id.in.(${people.join(',')}),entity_id.in.(${people.join(',')})`)
    if (f.q) qy = qy.or(`action.ilike.*${f.q.replace(/ /g, '_')}*,entity_type.ilike.*${f.q.replace(/ /g, '_')}*`)
    const { data, error } = await qy.order('created_at', { ascending: false }).order('id', { ascending: false }).range(fromRow, toRow)
    if (error) return { error: 'The audit could not be read just now. Please try again.' }
    raw = (data ?? []).map((r) => ({
      id: r.id, at: r.created_at, actor: r.actor_id, subject: r.entity_type === 'profile' ? r.entity_id : null, action: r.action,
      target: r.entity_type ? `${r.entity_type}${r.entity_id ? ` ${r.entity_id.slice(0, 8)}` : ''}` : '', detail: r.detail,
    }))
  } else {
    let qy = rls.from('auth_events').select('id, at, user_id, actor_id, event, ip, detail').eq('org_id', orgId)
    if (f.action) qy = qy.eq('event', f.action)
    else if (f.category) qy = qy.in('event', AUDIT_ACTIONS.filter((a) => a.table === 'auth_events' && a.category === f.category).map((a) => a.action))
    if (gte) qy = qy.gte('at', gte)
    if (lt) qy = qy.lt('at', lt)
    if (people) qy = qy.or(`user_id.in.(${people.join(',')}),actor_id.in.(${people.join(',')})`)
    if (f.q) qy = qy.or(`event.ilike.*${f.q.replace(/ /g, '_')}*,ip.ilike.*${f.q}*`)
    const { data, error } = await qy.order('at', { ascending: false }).order('id', { ascending: false }).range(fromRow, toRow)
    if (error) return { error: 'The audit could not be read just now. Please try again.' }
    raw = (data ?? []).map((r) => ({
      id: r.id, at: r.at, actor: r.actor_id ?? r.user_id, subject: r.actor_id ? r.user_id : null, action: r.event,
      target: r.ip ? `from ${r.ip}` : '', detail: r.detail,
    }))
  }
  const hasMore = raw.length > AUDIT_PAGE_SIZE
  const page = raw.slice(0, AUDIT_PAGE_SIZE)
  const ids = [...new Set(page.flatMap((r) => [r.actor, r.subject]).filter((x): x is string => !!x))]
  const who = new Map<string, string>()
  if (ids.length > 0) {
    const { data } = await names.from('profiles').select('id, full_name, email').eq('org_id', orgId).in('id', ids)
    for (const p of data ?? []) who.set(p.id, p.full_name ? `${p.full_name} (${p.email})` : p.email)
  }
  const table = f.kind === 'actions' ? 'admin_audit_log' : 'auth_events'
  return {
    hasMore,
    rows: page.map((r) => ({
      id: r.id,
      at: r.at,
      who: r.actor ? who.get(r.actor) ?? 'A person no longer listed' : 'The system',
      what: auditLabel(table, r.action),
      action: r.action,
      target: r.subject ? `${who.get(r.subject) ?? 'a person'}${r.target && f.kind === 'sign_ins' ? ` ${r.target}` : ''}` : r.target,
      detail: compact(r.detail),
    })),
  }
}
