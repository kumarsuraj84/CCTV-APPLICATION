'use client'

import Link from 'next/link'
import { useActionState } from 'react'
import { createUserAction, type CreateUserState } from '@/lib/actions/admin/users'
import { MSG_ROLES_GIVE_NO_ACCESS, ROLE_HELP, ROLE_LABELS, type Role } from '@/lib/admin/roles'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { FIELD, FOCUS, HELP, LABEL, NOTE } from './fields'

// A role says what a person may administer, never what they may see: that comes only from the access they are given (P2-1, AC-8).
// The person is created with no access at all; "Assign access next" opens the access editor (P2-3). A super administrator is the
// exception (owner ruling P-1): they get every right at once.
export function CreateUserForm({ allowedRoles, stores, canAssignAccess = true }: { allowedRoles: string[]; stores: { id: string; code: string; name: string }[]; canAssignAccess?: boolean }) {
  const [state, action, pending] = useActionState<CreateUserState, FormData>(createUserAction, {})
  return (
    <Card>
      <CardHeader>
        <CardTitle>Add a person</CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <p className={HELP}>{MSG_ROLES_GIVE_NO_ACCESS} A new person starts with no access.</p>
        <form action={action} className="grid gap-4 sm:grid-cols-2">
          <div className="space-y-1.5">
            <label htmlFor="full_name" className={LABEL}>Name</label>
            <input id="full_name" name="full_name" defaultValue={state.values?.full_name ?? ''} required className={FIELD} autoComplete="off" />
          </div>
          <div className="space-y-1.5">
            <label htmlFor="email" className={LABEL}>E-mail</label>
            <input id="email" name="email" type="email" defaultValue={state.values?.email ?? ''} required className={FIELD} autoComplete="off" placeholder="name@citykart.example" />
          </div>
          <div className="space-y-1.5">
            <label htmlFor="role" className={LABEL}>Role</label>
            <select id="role" name="role" defaultValue={state.values?.role ?? 'user'} className={FIELD} aria-describedby="role-help">
              {allowedRoles.map((r) => (
                <option key={r} value={r}>{ROLE_LABELS[r as Role] ?? r}</option>
              ))}
            </select>
            <ul id="role-help" className={`${HELP} list-disc space-y-0.5 pl-4`}>
              {allowedRoles.map((r) => <li key={r}><span className="font-medium">{ROLE_LABELS[r as Role] ?? r}:</span> {ROLE_HELP[r as Role]}</li>)}
            </ul>
          </div>
          <div className="space-y-1.5">
            <label htmlFor="store_id" className={LABEL}>Home location (optional, for information: gives no access)</label>
            <select id="store_id" name="store_id" defaultValue={state.values?.store_id ?? ''} className={FIELD}>
              <option value="">No home location</option>
              {stores.map((s) => (
                <option key={s.id} value={s.id}>{s.code} · {s.name}</option>
              ))}
            </select>
          </div>
          <div className="sm:col-span-2">
            <button type="submit" disabled={pending} className={`rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/85 disabled:cursor-not-allowed disabled:bg-[#EAF1F8] disabled:text-[#5B646F] ${FOCUS}`}>
              {pending ? 'Adding…' : 'Add person'}
            </button>
          </div>
        </form>
        {state.error && <p role="alert" className="text-sm font-medium text-destructive">{state.error}</p>}
        {state.created && (
          <div className="space-y-1 rounded-lg border bg-muted p-3 text-sm" role="status">
            <p className="font-medium">{state.created.email} was added, with no access yet.</p>
            <p>One-time password: <code className="font-mono">{state.created.oneTimePassword}</code></p>
            <p className="text-muted-foreground">This is shown only once. Give it to the person. They must choose their own password the first time they sign in.</p>
            {state.created.warning && <p className={NOTE}>{state.created.warning}</p>}
            {canAssignAccess && (
              <p><Link href={`/admin/users/${state.created.userId}/access`} className={`font-medium underline ${FOCUS}`}>Assign access next</Link></p>
            )}
          </div>
        )}
      </CardContent>
    </Card>
  )
}
