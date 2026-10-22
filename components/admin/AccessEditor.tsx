'use client'

import { useRouter } from 'next/navigation'
import { useMemo, useState, useTransition } from 'react'
import { applyAccessAction, previewAccessAction, type PreviewState } from '@/lib/actions/admin/access'
import type { EditorData, GrantView } from '@/lib/admin/access'
import { hasReason, presetChanges, PRESETS, type ChangeInput, type GrantChangeInput } from '@/lib/admin/access-rules'
import { ROLE_LABELS, type Role } from '@/lib/admin/roles'
import { AccessBuilder, type BuilderPrefill } from './AccessBuilder'
import { AccessGrantTable } from './AccessGrantTable'
import { AccessPreviewPanel } from './AccessPreviewPanel'
import { formatDay } from './access-labels'
import { BADGE, FIELD, FOCUS, HELP, NOTE, STATUS } from './fields'

export type EditorPrefill = { revokeIds: string[]; revokeReason: string; builder: BuilderPrefill | null }

const PRIMARY = `rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/85 disabled:cursor-not-allowed disabled:bg-[#EAF1F8] disabled:text-[#5B646F] ${FOCUS}`
const SECONDARY = `rounded-md border border-[#7C8795] px-3 py-2 text-sm hover:bg-muted disabled:cursor-not-allowed disabled:text-[#5B646F] ${FOCUS}`

/**
 * The access editor (P2-3; replaces the interim editor of P2-1). The administrator builds a list of changes — grants to add and grants
 * to remove, each with its reason — then checks their effect (the preview from the database) and saves exactly what was checked.
 * Nothing is edited in place: a grant is added or removed, and its history stays.
 */
export function AccessEditor(props: { userId: string; data: EditorData; prefill?: EditorPrefill }) {
  const { data } = props
  const router = useRouter()
  const byId = useMemo(() => new Map(data.grants.map((g) => [g.id, g])), [data.grants])
  const initial: ChangeInput[] = (props.prefill?.revokeIds ?? []).filter((id) => byId.get(id) && byId.get(id)!.state !== 'revoked').map((grant_id) => ({ op: 'revoke', grant_id, reason: props.prefill?.revokeReason ?? '' }))
  const [pending, setPending] = useState<ChangeInput[]>(data.editable ? initial : [])
  const [preview, setPreview] = useState<{ key: string; state: PreviewState } | null>(null)
  const [status, setStatus] = useState<string | null>(null)
  const [busy, start] = useTransition()
  const key = JSON.stringify(pending)
  const current = preview && preview.key === key && preview.state.ok ? preview.state : null
  const conflict = preview?.state.ok === false && preview.state.conflict

  const loc = useMemo(() => new Map(data.locations.map((l) => [l.id, `${l.code} · ${l.name}`])), [data.locations])
  const cam = useMemo(() => new Map(data.cameras.map((c) => [c.id, `${data.locations.find((l) => l.id === c.store_id)?.code ?? ''} · ${c.name}`])), [data.cameras, data.locations])
  const asset = useMemo(() => new Map(data.assets.map((a) => [a.id, a.name])), [data.assets])
  const capLabel = useMemo(() => new Map(data.catalogue.map((c) => [c.key, c.description])), [data.catalogue])
  const node = useMemo(() => new Map<string, string>([
    ...(data.regions ?? []).map((r) => [r.id, `Region ${r.code} · ${r.name}`] as [string, string]),
    ...(data.clusters ?? []).map((c) => [c.id, `Cluster ${c.code} · ${c.name}`] as [string, string]),
    ...(data.recorders ?? []).map((n) => [n.id, `NVR ${data.locations.find((l) => l.id === n.location_id)?.code ?? ''} · ${n.name}`] as [string, string]),
  ]), [data.regions, data.clusters, data.recorders, data.locations])
  const where = (g: GrantChangeInput) =>
    g.scope_kind === 'organization' ? 'Whole organisation' : g.scope_kind === 'location' ? `${loc.get(g.scope_id!) ?? 'Location'} (all, incl. later)` : g.scope_kind === 'camera' ? `${cam.get(g.scope_id!) ?? 'Camera'} (this camera only)`
      : g.scope_kind === 'region' || g.scope_kind === 'cluster' ? `${node.get(g.scope_id!) ?? g.scope_kind} (all its locations, incl. later)`
        : g.scope_kind === 'recorder' ? `${node.get(g.scope_id!) ?? 'NVR'} (its cameras only)` : asset.get(g.scope_id!) ?? 'Asset'

  const staged = new Set(pending.filter((c) => c.op === 'revoke').map((c) => (c as { grant_id: string }).grant_id))
  const addChanges = (list: ChangeInput[]) => {
    setStatus(null)
    setPending((p) => {
      const seen = new Set(p.map((c) => JSON.stringify(c)))
      return [...p, ...list.filter((c) => !seen.has(JSON.stringify(c)))]
    })
  }
  const stageRevoke = (g: GrantView) => addChanges([{ op: 'revoke', grant_id: g.id, reason: '' }])
  const setReason = (i: number, reason: string) => setPending((p) => p.map((c, j) => (j === i ? { ...c, reason } : c)))
  const remove = (i: number) => setPending((p) => p.filter((_, j) => j !== i))

  const check = () => {
    setStatus(null)
    if (pending.some((c) => c.op === 'revoke' && !hasReason(c.reason))) {
      setPreview({ key, state: { ok: false, error: 'Give a reason for each removal (at least three characters).' } })
      return
    }
    start(async () => {
      const state = await previewAccessAction(props.userId, { changes: pending, expectedVersion: data.version })
      setPreview({ key, state })
    })
  }
  const save = () => {
    if (!current) return
    start(async () => {
      const res = await applyAccessAction(props.userId, { changes: pending, expectedVersion: current.version, token: current.token })
      if (res.ok) {
        setPending([])
        setPreview(null)
        setStatus(`Saved. ${res.added} ${res.added === 1 ? 'grant' : 'grants'} added, ${res.revoked} removed.`)
        router.refresh()
      } else {
        setPreview({ key, state: res })
      }
    })
  }

  const role = data.person.role as Role
  const isSuper = role === 'platform_owner'
  const fullPreset = PRESETS.find((p) => p.id === 'full-rights')!
  const heldOrgWide = new Set(data.grants.filter((g) => g.state === 'active' && g.scopeKind === 'organization').map((g) => g.capability))
  const missing = data.catalogue.filter((c) => (c.scope_kinds ?? []).includes('organization') && !heldOrgWide.has(c.key))
  const restore = () => addChanges(presetChanges(fullPreset, { locations: [], catalogue: data.catalogue, grantable: data.grantable, validUntil: null, reason: 'Restore the full rights of a super administrator' }).filter((c) => !heldOrgWide.has(c.capability)))

  return (
    <div className="space-y-6">
      <div className={STATUS}>
        <span className="font-medium">{data.person.full_name || data.person.email}</span> · {data.person.email} · {ROLE_LABELS[role] ?? role} ·{' '}
        {data.person.is_active ? (data.person.must_reset_password ? 'Waiting for first sign-in' : 'Active') : 'Deactivated'}
      </div>
      <p className="max-w-3xl text-sm text-muted-foreground">
        Access adds up: a person may use a camera, recording or asset when any of their grants covers it. Nothing here narrows access
        silently — a camera grant next to a location grant adds nothing. To narrow access, remove the wider grant and add the narrower
        ones; the effect is shown before you save. A role gives no access by itself.
      </p>
      {!data.person.is_active && <p role="note" className={NOTE}>This person is deactivated. Their access applies again only if they are reactivated.</p>}
      {isSuper && (
        <div role="note" className={NOTE}>
          <p className="font-medium">Super administrator: full rights (all capabilities) for the whole organisation.</p>
          {missing.length === 0 ? <p>All {data.catalogue.length} rights are in place.</p> : (
            <>
              <p>{missing.length} of {data.catalogue.length} rights are missing: {missing.map((c) => c.description).join(', ')}.</p>
              {data.editable && <button type="button" onClick={restore} className={`mt-2 ${SECONDARY} bg-white text-foreground`}>Restore full rights</button>}
            </>
          )}
        </div>
      )}
      {!data.editable && data.notEditableReason && <p role="note" className={NOTE}>{data.notEditableReason} You can see the access but not change it.</p>}

      <section aria-labelledby="current-access" className="space-y-2">
        <h2 id="current-access" className="text-base font-semibold">Current access</h2>
        <AccessGrantTable grants={data.grants} mode="current" staged={staged} onRevoke={data.editable ? stageRevoke : undefined} />
      </section>

      {data.editable && (
        <AccessBuilder
          catalogue={data.catalogue} grantable={data.grantable} targetRole={role} locations={data.locations} cameras={data.cameras} assets={data.assets}
          regions={data.regions} clusters={data.clusters} recorders={data.recorders}
          prefill={props.prefill?.builder ?? null} onAdd={addChanges}
        />
      )}

      {data.editable && (
        <section aria-labelledby="pending" className="space-y-3 rounded-xl border bg-card p-4">
          <h2 id="pending" className="text-base font-semibold">Changes to save ({pending.length})</h2>
          {pending.length === 0 ? <p className="text-sm text-muted-foreground">No changes yet. Add access above or press “Remove…” next to a grant.</p> : (
            <ul className="space-y-2">
              {pending.map((c, i) => {
                if (c.op === 'grant') {
                  return (
                    <li key={i} className="flex flex-wrap items-start justify-between gap-2 rounded-lg border p-2 text-sm">
                      <span>
                        <span className={BADGE.ok}>Add</span> {capLabel.get(c.capability) ?? c.capability} · {where(c)} · {c.valid_until ? `until the end of ${formatDay(c.valid_until)}` : 'no end date'}
                        {c.reason && <span className="text-muted-foreground"> · reason: {c.reason}</span>}
                      </span>
                      <button type="button" onClick={() => remove(i)} className={SECONDARY} aria-label={`Take “${capLabel.get(c.capability) ?? c.capability} · ${where(c)}” off the list`}>Take off the list</button>
                    </li>
                  )
                }
                const g = byId.get(c.grant_id)
                const id = `revoke-reason-${i}`
                return (
                  <li key={i} className="space-y-2 rounded-lg border p-2 text-sm">
                    <div className="flex flex-wrap items-start justify-between gap-2">
                      <span><span className={BADGE.danger}>Remove</span> {g?.capabilityLabel} · {g?.scopeLabel}</span>
                      <button type="button" onClick={() => remove(i)} className={SECONDARY} aria-label={`Keep “${g?.capabilityLabel} · ${g?.scopeLabel}”`}>Keep it</button>
                    </div>
                    <label htmlFor={id} className="block text-sm font-medium">Reason for removing (required)</label>
                    <input id={id} value={c.reason} onChange={(e) => setReason(i, e.target.value)} maxLength={500} className={FIELD} placeholder="For example: moved to another location" />
                  </li>
                )
              })}
            </ul>
          )}
          <div className="flex flex-wrap gap-2">
            <button type="button" onClick={check} disabled={busy || pending.length === 0} className={SECONDARY}>{busy && !current ? 'Checking…' : 'Check the effect'}</button>
            <button type="button" onClick={save} disabled={busy || !current} className={PRIMARY} aria-describedby="save-help">{busy && current ? 'Saving…' : 'Save these changes'}</button>
            {pending.length > 0 && <button type="button" onClick={() => { setPending([]); setPreview(null) }} disabled={busy} className={SECONDARY}>Clear the list</button>}
          </div>
          <p id="save-help" className={HELP}>Saving is possible only after checking the effect of exactly these changes.</p>
          {preview && preview.key === key && !preview.state.ok && (
            <div role="alert" className="space-y-2 rounded-lg border border-red-700/40 bg-red-50 p-3 text-sm text-red-900 dark:bg-red-950 dark:text-red-100">
              <p>{preview.state.error}</p>
              {conflict && <button type="button" onClick={() => window.location.reload()} className={`${SECONDARY} bg-white text-foreground`}>Reload the page</button>}
            </div>
          )}
          {status && <p role="status" className={STATUS}>{status}</p>}
        </section>
      )}

      {current && <AccessPreviewPanel capabilities={current.capabilities} lines={current.lines} personActive={current.personActive} />}

      <details className="rounded-xl border bg-card p-4">
        <summary className={`cursor-pointer text-base font-semibold ${FOCUS}`}>History: removed grants ({data.grants.filter((g) => g.state === 'revoked').length})</summary>
        <div className="mt-3"><AccessGrantTable grants={data.grants} mode="history" /></div>
      </details>
    </div>
  )
}
