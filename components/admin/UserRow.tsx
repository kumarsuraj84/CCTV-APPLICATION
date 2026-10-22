'use client'

import Link from 'next/link'
import { useState, useTransition } from 'react'
import { reactivationReviewAction, resetPasswordAction, setActiveAction, type ReactivationState } from '@/lib/actions/admin/users'
import { ROLE_LABELS, type Role } from '@/lib/admin/roles'
import { formatDay, SOURCE_LABELS, STATE_LABELS } from './access-labels'
import { FIELD, FOCUS, NOTE, RT, STATUS } from './fields'

export type UserRowData = {
  id: string
  email: string
  full_name: string
  role: string
  is_active: boolean
  must_reset_password: boolean
  manageable: boolean
  is_self: boolean
  /** P2-2: the Access link only for an administrator who also holds admin.access (the access page needs it). */
  access_editable?: boolean
  /** P2-3: "Live: 3 locations, Playback: 3 locations, IT: none" — shown only to administrators with admin.access. */
  summary?: string | null
}

const BTN = `rounded-md border border-[#7C8795] px-2.5 py-1 text-sm hover:bg-muted disabled:cursor-not-allowed disabled:text-[#5B646F] ${FOCUS}`
// Neutral on purpose (P2-3 brief): open video is not cut off yet when a person is deactivated (that comes with P2-4).
export const MSG_DEACTIVATE =
  'They can no longer sign in, and the sign-ins they have now are ended. Their access is kept and applies again if they are reactivated.'

export function UserRow({ u, showSummary = false }: { u: UserRowData; showSummary?: boolean }) {
  const [pending, start] = useTransition()
  const [otp, setOtp] = useState<string | null>(null)
  const [panel, setPanel] = useState<'deactivate' | 'reactivate' | null>(null)
  const [review, setReview] = useState<ReactivationState | null>(null)
  const [reason, setReason] = useState('Old access reviewed on reactivation')
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null)
  const cols = showSummary ? 5 : 4

  const done = (res: { error?: string }, ok: string) => {
    setMessage(res.error ? { ok: false, text: res.error } : { ok: true, text: ok })
    if (!res.error) setPanel(null)
  }
  const deactivate = () => start(async () => done(await setActiveAction(u.id, false), 'Deactivated.'))
  const openReactivate = () =>
    start(async () => {
      setMessage(null)
      const r = await reactivationReviewAction(u.id)
      setReview(r)
      setPanel('reactivate')
    })
  const reactivate = (revoke: boolean) =>
    start(async () => {
      if (revoke && review?.ok) {
        done(await setActiveAction(u.id, true, { revokeAll: { grantIds: review.grants.map((g) => g.id), reason, expectedVersion: review.version } }), 'Reactivated. Their old access was removed.')
      } else {
        done(await setActiveAction(u.id, true), 'Reactivated with their access as listed.')
      }
    })
  const reset = () =>
    start(async () => {
      const res = await resetPasswordAction(u.id)
      if (res.error) setMessage({ ok: false, text: res.error })
      else setOtp(res.oneTimePassword ?? null)
    })

  return (
    <>
      <tr className={RT.tr}>
        <td className={RT.td}>
          <div className="font-medium">{u.full_name || '—'}</div>
          <div className="text-xs text-muted-foreground">{u.email}</div>
        </td>
        <td className={RT.td}><span className={RT.label}>Role:</span>{ROLE_LABELS[u.role as Role] ?? u.role}</td>
        <td className={RT.td}><span className={RT.label}>Status:</span>{!u.is_active ? 'Deactivated' : u.must_reset_password ? 'Waiting for first sign-in' : 'Active'}</td>
        {showSummary && <td className={RT.td}><span className={RT.label}>Access:</span>{u.summary ?? 'Live: none, Playback: none, IT: none'}</td>}
        <td className={RT.tdAction}>
          <div className="flex flex-wrap gap-2 md:justify-end">
            {/* Every role gets its access from grants, managers too (AC-8). */}
            {u.access_editable !== false && (
              <Link href={`/admin/users/${u.id}/access`} className={`${BTN} underline-offset-2`} aria-label={`Access of ${u.full_name || u.email}`}>Access</Link>
            )}
            {u.manageable && !u.is_self && (
              <>
                <button type="button" className={BTN} disabled={pending} onClick={reset}>Reset password</button>
                {u.is_active
                  ? <button type="button" className={BTN} disabled={pending} onClick={() => { setMessage(null); setPanel('deactivate') }}>Deactivate…</button>
                  : <button type="button" className={BTN} disabled={pending} onClick={openReactivate}>Activate…</button>}
              </>
            )}
          </div>
        </td>
      </tr>
      {panel === 'deactivate' && (
        <tr className="bg-muted/40">
          <td colSpan={cols} className="space-y-2 px-3 py-3 text-sm">
            <p><span className="font-medium">Deactivate {u.full_name || u.email}?</span> {MSG_DEACTIVATE}</p>
            <div className="flex flex-wrap gap-2">
              <button type="button" className={`${BTN} border-red-700 text-red-800 dark:text-red-200`} disabled={pending} onClick={deactivate}>Deactivate</button>
              <button type="button" className={BTN} disabled={pending} onClick={() => setPanel(null)}>Cancel</button>
            </div>
          </td>
        </tr>
      )}
      {panel === 'reactivate' && review && (
        <tr className="bg-muted/40">
          <td colSpan={cols} className="space-y-2 px-3 py-3 text-sm">
            {!review.ok ? <p role="alert" className="text-destructive">{review.error}</p> : (
              <>
                <p className="font-medium">Before you reactivate {u.full_name || u.email}: their access applies again as soon as they are active.</p>
                {review.grants.length === 0 ? <p>They have no access at the moment.</p> : (
                  <>
                    <p>They still have {review.grants.length} {review.grants.length === 1 ? 'grant' : 'grants'}:</p>
                    <ul className="max-h-56 list-disc space-y-0.5 overflow-y-auto pl-5">
                      {review.grants.map((g) => (
                        <li key={g.id}>{g.capabilityLabel} · {g.scopeLabel} · {STATE_LABELS[g.state] ?? g.state}{g.lastDay ? ` · until the end of ${formatDay(g.lastDay)}` : ''} · {SOURCE_LABELS[g.source] ?? g.source}</li>
                      ))}
                    </ul>
                    {review.canRevoke ? (
                      <div className="max-w-xl space-y-1.5">
                        <label htmlFor={`reason-${u.id}`} className="block text-sm font-medium">Reason, if you remove it all</label>
                        <input id={`reason-${u.id}`} value={reason} onChange={(e) => setReason(e.target.value)} maxLength={500} className={FIELD} />
                      </div>
                    ) : <p className={NOTE}>You cannot change access (that needs the access right), so you can only reactivate with this access or cancel.</p>}
                  </>
                )}
                <div className="flex flex-wrap gap-2">
                  <button type="button" className={BTN} disabled={pending} onClick={() => reactivate(false)}>{review.grants.length ? 'Reactivate and keep this access' : 'Reactivate'}</button>
                  {review.canRevoke && review.grants.length > 0 && (
                    <button type="button" className={`${BTN} border-red-700 text-red-800 dark:text-red-200`} disabled={pending} onClick={() => reactivate(true)}>Remove all of it and reactivate</button>
                  )}
                  <Link href={`/admin/users/${u.id}/access`} className={BTN}>Review in the access editor</Link>
                  <button type="button" className={BTN} disabled={pending} onClick={() => setPanel(null)}>Cancel</button>
                </div>
              </>
            )}
          </td>
        </tr>
      )}
      {message && (
        <tr>
          <td colSpan={cols} className="px-3 py-2">
            <p role={message.ok ? 'status' : 'alert'} className={message.ok ? STATUS : 'text-sm font-medium text-destructive'}>{message.text}</p>
          </td>
        </tr>
      )}
      {otp && (
        <tr className="bg-muted">
          <td colSpan={cols} className="px-3 py-2 text-sm">
            New one-time password for {u.email}: <code className="font-mono">{otp}</code>. Shown only once.
          </td>
        </tr>
      )}
    </>
  )
}
