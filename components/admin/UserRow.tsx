'use client'

import Link from 'next/link'
import { useState, useTransition } from 'react'
import { reactivationReviewAction, resetPasswordAction, setActiveAction, setRoleAction, type ReactivationState } from '@/lib/actions/admin/users'
import { ROLE_CHANGE_EFFECT, ROLE_LABELS, type Role } from '@/lib/admin/roles'
import { resetFactorsAction, signOutEverywhereAction } from '@/lib/actions/admin/sessions'
import { Select } from '@/components/ui/select'
import { formatDateTime } from '@/lib/time'
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
  /** P3-1: the person has an authenticator app (null: not known). */
  two_step?: boolean | null
  /** P3-1: the viewer is a super administrator, who may reset a person's two-step sign-in. */
  can_reset_two_step?: boolean
  /** Review I-4: when (ISO) and from which address the app was set up (the sign-in audit), so an unexpected set-up stands out. */
  two_step_since?: string | null
  two_step_from?: string | null
}

type Listed = { id: string; capabilityLabel: string; scopeLabel: string; lastDay: string | null; state: string; source: string }

const BTN = `rounded-md border border-[#7C8795] px-2.5 py-1 text-sm hover:bg-muted disabled:cursor-not-allowed disabled:text-[#5B646F] ${FOCUS}`
const DANGER = `${BTN} border-red-700 text-red-800 dark:text-red-200`
// P2-4: deactivation ends the person's open video too (the media session registry; within a minute, AC-14).
export const MSG_DEACTIVATE =
  'They can no longer sign in, the sign-ins they have now are ended, and their open video stops within a minute. Their access is kept and applies again if they are reactivated.'

function GrantList({ grants }: { grants: Listed[] }) {
  return (
    <ul className="max-h-56 list-disc space-y-0.5 overflow-y-auto pl-5">
      {grants.map((g) => (
        <li key={g.id}>{g.capabilityLabel} · {g.scopeLabel} · {STATE_LABELS[g.state] ?? g.state}{g.lastDay ? ` · until the end of ${formatDay(g.lastDay)}` : ''} · {SOURCE_LABELS[g.source] ?? g.source}</li>
      ))}
    </ul>
  )
}

/** Before reactivating: the old grants, kept or removed (review M-1, M-6: a super administrator's full set returns by itself). */
export function ReactivationPanel(p: {
  name: string; userId: string; targetRole: string; review: ReactivationState; reason: string; onReason: (v: string) => void
  onKeep: () => void; onRevokeAll: () => void; onCancel: () => void; pending: boolean
}) {
  const r = p.review
  if (!r.ok) return <p role="alert" className="text-destructive">{r.error}</p>
  const isSuper = p.targetRole === 'platform_owner'
  return (
    <>
      <p className="font-medium">Before you reactivate {p.name}: their access applies again as soon as they are active.</p>
      {isSuper && <p className={NOTE}>A super administrator gets every right back automatically when reactivated.</p>}
      {r.grants.length === 0 ? <p>They have no access at the moment.</p> : (
        <>
          <p>They still have {r.grants.length} {r.grants.length === 1 ? 'grant' : 'grants'}:</p>
          <GrantList grants={r.grants} />
          {!isSuper && (r.canRevoke ? (
            <div className="max-w-xl space-y-1.5">
              <label htmlFor={`reason-${p.userId}`} className="block text-sm font-medium">Reason, if you remove it all</label>
              <input id={`reason-${p.userId}`} value={p.reason} onChange={(e) => p.onReason(e.target.value)} maxLength={500} className={FIELD} />
            </div>
          ) : <p className={NOTE}>You cannot change access (that needs the access right), so you can only reactivate with this access or cancel.</p>)}
        </>
      )}
      <div className="flex flex-wrap gap-2">
        <button type="button" className={BTN} disabled={p.pending} onClick={p.onKeep}>{r.grants.length ? 'Reactivate and keep this access' : 'Reactivate'}</button>
        {!isSuper && r.canRevoke && r.grants.length > 0 && (
          <button type="button" className={DANGER} disabled={p.pending} onClick={p.onRevokeAll}>Remove all of it and reactivate</button>
        )}
        {r.canRevoke && <Link href={`/admin/users/${p.userId}/access`} className={BTN}>Review in the access editor</Link>}
        <button type="button" className={BTN} disabled={p.pending} onClick={p.onCancel}>Cancel</button>
      </div>
    </>
  )
}

/** Changing a role (review I-2): says what is removed, then asks to review the remaining access. */
export function RoleChangePanel(p: {
  name: string; userId: string; currentRole: string; allowedRoles: string[]; pending: boolean
  onChange: (role: string) => void; onCancel: () => void; result?: { revoked: number; remaining: Listed[] | null } | null
}) {
  const [role, setRole] = useState(p.allowedRoles.find((r) => r !== p.currentRole) ?? p.currentRole)
  if (p.result) {
    return (
      <section aria-label="Review remaining access" className="space-y-2">
        <h3 className="font-medium">Review remaining access</h3>
        <p>The role of {p.name} was changed. {p.result.revoked === 0 ? 'No rights were removed.' : `${p.result.revoked} ${p.result.revoked === 1 ? 'right was' : 'rights were'} removed.`}</p>
        {p.result.remaining === null ? <p className={NOTE}>Someone with the access right should review what they can still use.</p>
          : p.result.remaining.length === 0 ? <p>They have no other access.</p> : (<><p>What they can still use:</p><GrantList grants={p.result.remaining} /></>)}
        <div className="flex flex-wrap gap-2">
          <Link href={`/admin/users/${p.userId}/access`} className={BTN}>Open their access</Link>
          <button type="button" className={BTN} onClick={p.onCancel}>Done</button>
        </div>
      </section>
    )
  }
  const id = `role-${p.userId}`
  return (
    <div className="space-y-2">
      <div className="max-w-sm space-y-1.5">
        <label htmlFor={id} className="block text-sm font-medium">New role for {p.name}</label>
        <Select id={id} value={role} onChange={(e) => setRole(e.target.value)}>
          {p.allowedRoles.map((r) => <option key={r} value={r}>{ROLE_LABELS[r as Role] ?? r}</option>)}
        </Select>
      </div>
      <p>{ROLE_CHANGE_EFFECT(p.currentRole as Role, role as Role)}</p>
      <div className="flex flex-wrap gap-2">
        <button type="button" className={BTN} disabled={p.pending || role === p.currentRole} onClick={() => p.onChange(role)}>Change role</button>
        <button type="button" className={BTN} disabled={p.pending} onClick={p.onCancel}>Cancel</button>
      </div>
    </div>
  )
}

export function UserRow({ u, showSummary = false, allowedRoles = [] }: { u: UserRowData; showSummary?: boolean; allowedRoles?: string[] }) {
  const [pending, start] = useTransition()
  const [otp, setOtp] = useState<string | null>(null)
  const [panel, setPanel] = useState<'deactivate' | 'reactivate' | 'role' | 'signout' | 'two-step' | null>(null)
  const [resetReason, setResetReason] = useState('')
  const [review, setReview] = useState<ReactivationState | null>(null)
  const [roleResult, setRoleResult] = useState<{ revoked: number; remaining: Listed[] | null } | null>(null)
  const [reason, setReason] = useState('Old access reviewed on reactivation')
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null)
  const cols = showSummary ? 5 : 4
  const name = u.full_name || u.email

  const done = (res: { error?: string }, ok: string) => {
    setMessage(res.error ? { ok: false, text: res.error } : { ok: true, text: ok })
    if (!res.error) setPanel(null)
  }
  const deactivate = () => start(async () => done(await setActiveAction(u.id, false), 'Deactivated.'))
  const openReactivate = () =>
    start(async () => {
      setMessage(null)
      setReview(await reactivationReviewAction(u.id))
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
  const openRole = () =>
    start(async () => {
      setMessage(null)
      setRoleResult(null)
      // The access version, when the administrator may read access: the role change then refuses to act on a changed person.
      setReview(await reactivationReviewAction(u.id))
      setPanel('role')
    })
  const changeRole = (role: string) =>
    start(async () => {
      const res = await setRoleAction(u.id, role, review?.ok ? review.version : null)
      if (res.error) setMessage({ ok: false, text: res.error })
      else setRoleResult({ revoked: res.revoked ?? 0, remaining: res.remaining ?? null })
    })
  const reset = () =>
    start(async () => {
      const res = await resetPasswordAction(u.id)
      if (res.error) setMessage({ ok: false, text: res.error })
      else setOtp(res.oneTimePassword ?? null)
    })
  // P3-1: end every sign-in; reset the authenticator app (super administrators).
  const signOutAll = () =>
    start(async () => {
      const res = await signOutEverywhereAction(u.id)
      done(res.ok ? {} : { error: res.error }, `${name} is signed out everywhere. Their open video stops within a minute.`)
    })
  const resetTwoStep = () =>
    start(async () => {
      const res = await resetFactorsAction(u.id, resetReason)
      done(res.ok ? {} : { error: res.error }, `Two-step sign-in of ${name} was reset and they are signed out everywhere.${res.ok && res.removed === 0 ? ' They had no authenticator app.' : ''}`)
      if (res.ok) setResetReason('')
    })

  return (
    <>
      <tr className={RT.tr}>
        <td className={RT.td}>
          <div className="font-medium">{u.full_name || '—'}</div>
          <div className="text-xs text-muted-foreground" translate="no">{u.email}</div>
        </td>
        <td className={RT.td}><span className={RT.label}>Role:</span>{ROLE_LABELS[u.role as Role] ?? u.role}</td>
        <td className={RT.td}>
          <span className={RT.label}>Status:</span>{!u.is_active ? 'Deactivated' : u.must_reset_password ? 'Waiting for first sign-in' : 'Active'}
          {u.two_step !== undefined && u.two_step !== null && (
            <span className="block text-xs text-muted-foreground">
              {u.two_step ? 'Two-step sign-in: on' : 'Two-step sign-in: off'}
              {u.two_step && u.two_step_since && (
                <span className="block" translate="no">set up {formatDateTime(u.two_step_since)} IST{u.two_step_from ? ` from ${u.two_step_from}` : ''}</span>
              )}
            </span>
          )}
        </td>
        {showSummary && <td className={RT.td}><span className={RT.label}>Access:</span>{u.summary ?? 'Live: none, Playback: none, IT: none'}</td>}
        <td className={RT.tdAction}>
          <div className="flex flex-wrap gap-2 md:justify-end">
            {/* Every role gets its access from grants, managers too (AC-8). */}
            {u.access_editable !== false && (
              <Link href={`/admin/users/${u.id}/access`} className={`${BTN} underline-offset-2`} aria-label={`Access of ${name}`}>Access</Link>
            )}
            {u.manageable && !u.is_self && (
              <>
                {allowedRoles.length > 1 && <button type="button" className={BTN} disabled={pending} onClick={openRole}>Change role…</button>}
                <button type="button" className={BTN} disabled={pending} onClick={reset}>Reset password</button>
                {u.is_active
                  ? <button type="button" className={BTN} disabled={pending} onClick={() => { setMessage(null); setPanel('deactivate') }}>Deactivate…</button>
                  : <button type="button" className={BTN} disabled={pending} onClick={openReactivate}>Activate…</button>}
                {u.is_active && <button type="button" className={BTN} disabled={pending} onClick={() => { setMessage(null); setPanel('signout') }}>Sign out everywhere…</button>}
              </>
            )}
            {u.can_reset_two_step && !u.is_self && u.two_step && (
              <button type="button" className={BTN} disabled={pending} onClick={() => { setMessage(null); setPanel('two-step') }}>Reset two-step sign-in…</button>
            )}
          </div>
        </td>
      </tr>
      {panel === 'deactivate' && (
        <tr className="bg-muted/40">
          <td colSpan={cols} className="space-y-2 px-3 py-3 text-sm">
            <p><span className="font-medium">Deactivate {name}?</span> {MSG_DEACTIVATE}</p>
            <div className="flex flex-wrap gap-2">
              <button type="button" className={DANGER} disabled={pending} onClick={deactivate}>Deactivate</button>
              <button type="button" className={BTN} disabled={pending} onClick={() => setPanel(null)}>Cancel</button>
            </div>
          </td>
        </tr>
      )}
      {panel === 'signout' && (
        <tr className="bg-muted/40">
          <td colSpan={cols} className="space-y-2 px-3 py-3 text-sm">
            <p><span className="font-medium">Sign {name} out everywhere?</span> Every computer and phone they are signed in on must sign in again, and their open video stops within a minute. Nothing else changes.</p>
            <div className="flex flex-wrap gap-2">
              <button type="button" className={DANGER} disabled={pending} onClick={signOutAll}>Sign out everywhere</button>
              <button type="button" className={BTN} disabled={pending} onClick={() => setPanel(null)}>Cancel</button>
            </div>
          </td>
        </tr>
      )}
      {panel === 'two-step' && (
        <tr className="bg-muted/40">
          <td colSpan={cols} className="space-y-2 px-3 py-3 text-sm">
            <p>
              <span className="font-medium">Reset the two-step sign-in of {name}?</span> Their authenticator app stops working, they are signed out
              everywhere, and they set up a new app the next time they sign in (where it is required). Use this when they lost their phone.
            </p>
            <div className="max-w-xl space-y-1.5">
              <label htmlFor={`mfa-reason-${u.id}`} className="block text-sm font-medium">Reason (kept in the audit log)</label>
              <input id={`mfa-reason-${u.id}`} value={resetReason} onChange={(e) => setResetReason(e.target.value)} maxLength={500} className={FIELD} placeholder="Lost phone, confirmed by call" />
            </div>
            <div className="flex flex-wrap gap-2">
              <button type="button" className={DANGER} disabled={pending || resetReason.trim().length < 3} onClick={resetTwoStep}>Reset two-step sign-in</button>
              <button type="button" className={BTN} disabled={pending} onClick={() => setPanel(null)}>Cancel</button>
            </div>
          </td>
        </tr>
      )}
      {panel === 'reactivate' && review && (
        <tr className="bg-muted/40">
          <td colSpan={cols} className="space-y-2 px-3 py-3 text-sm">
            <ReactivationPanel name={name} userId={u.id} targetRole={u.role} review={review} reason={reason} onReason={setReason} pending={pending}
              onKeep={() => reactivate(false)} onRevokeAll={() => reactivate(true)} onCancel={() => setPanel(null)} />
          </td>
        </tr>
      )}
      {panel === 'role' && (
        <tr className="bg-muted/40">
          <td colSpan={cols} className="space-y-2 px-3 py-3 text-sm">
            <RoleChangePanel name={name} userId={u.id} currentRole={u.role} allowedRoles={allowedRoles} pending={pending} onChange={changeRole}
              onCancel={() => { setPanel(null); setRoleResult(null) }} result={roleResult} />
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
