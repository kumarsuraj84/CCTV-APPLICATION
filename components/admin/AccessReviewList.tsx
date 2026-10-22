'use client'

import Link from 'next/link'
import { useState, useTransition } from 'react'
import { keepReviewedAction, selfConfirmReviewAction } from '@/lib/actions/admin/access'
import type { ReviewItem } from '@/lib/admin/access'
import { ROLE_LABELS, type Role } from '@/lib/admin/roles'
import { SOURCE_LABELS, validityText } from './access-labels'
import { BADGE, FIELD, FOCUS, HELP, RT, STATUS } from './fields'

export type ReviewGroup = { userId: string; personName: string; personEmail: string; personRole: string; personActive: boolean; manageable: boolean; self: boolean; items: ReviewItem[] }

const LINK = `rounded-md border border-[#7C8795] px-2.5 py-1 text-sm hover:bg-muted ${FOCUS}`

/**
 * The open review items per person (P2-3, D-2a): grants moved over from the home-location rule, the manager role and the
 * administrator role. "Keep (confirm)" records the decision (and an audit event); "Remove" and "Convert to scoped grants" open the
 * access editor with the change prepared, where its effect is shown before anything is saved.
 */
export function AccessReviewList({ groups, selfConfirm = false }: { groups: ReviewGroup[]; selfConfirm?: boolean }) {
  if (groups.length === 0) return <p className={STATUS}>Nothing is waiting for review.</p>
  return (
    <div className="space-y-4">
      {groups.map((g) => <Group key={g.userId} g={g} selfConfirm={selfConfirm} />)}
    </div>
  )
}

function Group({ g, selfConfirm }: { g: ReviewGroup; selfConfirm: boolean }) {
  const [note, setNote] = useState('')
  const [selfReason, setSelfReason] = useState('')
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null)
  const [busy, start] = useTransition()
  const keep = (ids: string[]) =>
    start(async () => {
      const res = await keepReviewedAction({ grantIds: ids, note: note.trim() || null })
      setMessage(res.ok ? { ok: true, text: `Kept ${res.kept} ${res.kept === 1 ? 'grant' : 'grants'}.` } : { ok: false, text: res.error })
    })
  const selfConfirmAll = () =>
    start(async () => {
      const res = await selfConfirmReviewAction({ grantIds: g.items.map((i) => i.grantId), reason: selfReason.trim() })
      setMessage(res.ok ? { ok: true, text: `Confirmed ${res.confirmed} of your own grants (self-confirmed, single super administrator).` } : { ok: false, text: res.error })
    })
  const canAct = g.manageable && !g.self
  const keepable = g.items.filter((i) => !i.keepRefusal)
  const noteId = `note-${g.userId}`
  return (
    <section aria-labelledby={`p-${g.userId}`} className="space-y-3 rounded-xl border bg-card p-4">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 id={`p-${g.userId}`} className="text-base font-semibold">
          {g.personName} <span className="text-sm font-normal text-muted-foreground">· {g.personEmail} · {ROLE_LABELS[g.personRole as Role] ?? g.personRole}{g.personActive ? '' : ' · deactivated'}</span>
        </h2>
        <Link href={`/admin/users/${g.userId}/access`} className={`text-sm underline ${FOCUS}`}>Open access</Link>
      </div>
      <div className="overflow-x-auto rounded-lg border">
        <table className={RT.table}>
          <caption className="sr-only">Grants of {g.personName} waiting for review</caption>
          <thead className={RT.thead}>
            <tr><th scope="col" className="px-3 py-2 font-medium">Right</th><th scope="col" className="px-3 py-2 font-medium">Where</th><th scope="col" className="px-3 py-2 font-medium">Came from</th><th scope="col" className="px-3 py-2"><span className="sr-only">Decision</span></th></tr>
          </thead>
          <tbody className={RT.tbody}>
            {g.items.map((i) => (
              <tr key={i.grantId} className={RT.tr}>
                <td className={RT.td}><div className="font-medium">{i.capabilityLabel}</div><div className={HELP}>{validityText(i)}</div></td>
                <td className={RT.td}><span className={RT.label}>Where:</span>{i.scopeLabel}</td>
                <td className={RT.td}><span className={RT.label}>Came from:</span>{SOURCE_LABELS[i.source] ?? i.source} {i.needsReview && <span className={BADGE.warn}>Please review</span>}</td>
                <td className={RT.tdAction}>
                  {canAct ? (
                    <div className="flex flex-wrap gap-1.5 md:justify-end">
                      {i.keepRefusal
                        ? <span className={HELP} title={i.keepRefusal}>You can only confirm access you could give yourself.</span>
                        : <button type="button" disabled={busy} onClick={() => keep([i.grantId])} className={LINK} aria-label={`Keep ${i.capabilityLabel} for ${i.scopeLabel} (confirm)`}>Keep (confirm)</button>}
                      <Link href={`/admin/users/${g.userId}/access?revoke=${i.grantId}`} className={LINK} aria-label={`Remove ${i.capabilityLabel} for ${i.scopeLabel}`}>Remove…</Link>
                      <Link href={`/admin/users/${g.userId}/access?convert=${i.grantId}`} className={LINK} aria-label={`Convert ${i.capabilityLabel} for ${i.scopeLabel} to scoped grants`}>Convert to scoped grants</Link>
                    </div>
                  ) : <span className={HELP}>{g.self ? (selfConfirm ? 'You are the only super administrator: confirm below with a reason.' : 'Another administrator must review your own access.') : 'Only a super administrator can review this person.'}</span>}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {g.self && selfConfirm && (
        <div className="space-y-2 rounded-lg border border-amber-700/40 p-3">
          <p className="text-sm">
            <span className="font-medium">Break-glass: you are the only active super administrator,</span> so nobody else can review your
            own access. You may confirm it yourself with a reason. It is recorded as “self-confirmed (single super administrator)” and
            audited; once a second super administrator exists, they review it instead.
          </p>
          <div className="flex flex-wrap items-end gap-2">
            <div className="min-w-0 flex-1 space-y-1.5">
              <label htmlFor={`self-${g.userId}`} className="block text-sm font-medium">Reason (at least 10 characters, required)</label>
              <input id={`self-${g.userId}`} value={selfReason} onChange={(e) => setSelfReason(e.target.value)} maxLength={500} className={FIELD} placeholder="For example: only super administrator, set up the system" />
            </div>
            <button type="button" disabled={busy || selfReason.trim().length < 10} onClick={selfConfirmAll} className={`rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/85 disabled:cursor-not-allowed disabled:bg-[#EAF1F8] disabled:text-[#5B646F] ${FOCUS}`}>
              Confirm my own access
            </button>
          </div>
        </div>
      )}
      {canAct && (
        <div className="flex flex-wrap items-end gap-2">
          <div className="min-w-0 flex-1 space-y-1.5">
            <label htmlFor={noteId} className="text-sm font-medium">Note for the review (optional)</label>
            <input id={noteId} value={note} onChange={(e) => setNote(e.target.value)} maxLength={500} className={FIELD} placeholder="For example: confirmed with the area manager" />
          </div>
          {keepable.length > 0 && (
            <button type="button" disabled={busy} onClick={() => keep(keepable.map((i) => i.grantId))} className={`rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/85 ${FOCUS}`}>
              {busy ? 'Saving…' : `Keep all ${keepable.length} you may confirm`}
            </button>
          )}
        </div>
      )}
      {message && <p role={message.ok ? 'status' : 'alert'} className={message.ok ? STATUS : 'text-sm font-medium text-destructive'}>{message.text}</p>}
    </section>
  )
}
