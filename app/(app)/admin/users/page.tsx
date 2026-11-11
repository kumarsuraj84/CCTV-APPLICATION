import Link from 'next/link'
import { CreateUserForm } from '@/components/admin/CreateUserForm'
import { FIELD, FOCUS, NOTE, RT } from '@/components/admin/fields'
import { UserRow } from '@/components/admin/UserRow'
import { PageHeader } from '@/components/ui/PageHeader'
import { accessSummaries, listReview } from '@/lib/admin/access'
import { canManageRole, ROLE_LABELS, ROLES } from '@/lib/admin/roles'
import { listStoresForAccess, listUsers } from '@/lib/admin/users'
import { mayAdminister, requireAdministration } from '@/lib/auth/profile'
import { createAdminClient } from '@/lib/supabase/admin'
import { codeLocks, twoStepSummary } from '@/lib/admin/sessions'

export const metadata = { title: 'Users' }

// P2-2: an administrative role AND admin.users. P2-3: with admin.access as well, the access summary per person, the Access links and
// the count of migrated grants waiting for review (the administration home for access).
// Final fix Y (final review C M-13): a search (name or e-mail address) and a role filter, for an organisation of 250+ people; and (B I-2)
// each person's wrong codes in a row and a locked code step.
const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] ?? '' : v ?? '').trim()

export default async function UsersPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const me = await requireAdministration('admin.users')
  const sp = await searchParams
  const q = one(sp.q).slice(0, 80).toLowerCase()
  const roleFilter = (ROLES as readonly string[]).includes(one(sp.role)) ? one(sp.role) : ''
  const accessEditable = mayAdminister(me, 'admin.access')
  const admin = createAdminClient()
  const [allUsers, stores, summaries, review, twoStep, locks] = await Promise.all([
    listUsers(admin, me.org_id),
    listStoresForAccess(admin, me.org_id),
    accessEditable ? accessSummaries(admin, me.org_id).catch(() => null) : Promise.resolve(null),
    accessEditable ? listReview(admin, me.org_id).catch(() => null) : Promise.resolve(null),
    // P3-1: who has an authenticator app (nothing about the app itself).
    twoStepSummary(admin, me.org_id).catch(() => null),
    codeLocks(admin, me.org_id).catch(() => null),
  ])
  const users = allUsers.filter((u) => (!roleFilter || u.role === roleFilter)
    && (!q || (u.full_name ?? '').toLowerCase().includes(q) || u.email.toLowerCase().includes(q)))
  const allowedRoles = ROLES.filter((r) => canManageRole(me.role, r))
  const showSummary = summaries !== null
  return (
    <div className="space-y-6">
      <PageHeader
        title="Users"
        description="Add people and give them access."
        actions={accessEditable ? <Link href="/admin/access-review" className={`text-sm underline ${FOCUS}`}>Access review{review ? ` (${review.openCount})` : ''}</Link> : undefined}
      />
      {review && review.openCount > 0 && (
        <p role="note" className={NOTE}>
          {review.openCount} {review.openCount === 1 ? 'grant moved over from the old access rules is' : 'grants moved over from the old access rules are'} waiting for review.{' '}
          <Link href="/admin/access-review" className={`font-medium underline ${FOCUS}`}>Review them</Link>
        </p>
      )}
      {accessEditable && summaries === null && <p role="alert" className="text-sm text-destructive">The access summary could not be read just now. Reload the page in a moment.</p>}
      <CreateUserForm allowedRoles={[...allowedRoles]} stores={stores} canAssignAccess={accessEditable} />
      <p className="max-w-3xl text-sm text-muted-foreground">
        Roles give no access by themselves (a super administrator holds every right). When someone leaves the administrator roles, their
        administration and download rights are removed; when someone stops being a super administrator, the rights only a super
        administrator may hold are removed. Other access stays and is shown for review.
      </p>
      <form method="get" role="search" aria-label="Find people" className="flex flex-wrap items-end gap-3">
        <div className="space-y-1.5">
          <label htmlFor="users-q" className="block text-sm font-medium">Name or e-mail address</label>
          <input id="users-q" name="q" defaultValue={one(sp.q)} maxLength={80} className={`${FIELD} text-base sm:text-sm`} />
        </div>
        <div className="space-y-1.5">
          <label htmlFor="users-role" className="block text-sm font-medium">Role</label>
          <select id="users-role" name="role" defaultValue={roleFilter} className={`${FIELD} text-base sm:text-sm`}>
            <option value="">Every role</option>
            {ROLES.map((r) => <option key={r} value={r}>{ROLE_LABELS[r]}</option>)}
          </select>
        </div>
        <button type="submit" className={`rounded-md border px-3 py-2 text-sm ${FOCUS}`}>Find</button>
        {(q || roleFilter) && <Link href="/admin/users" className={`text-sm underline ${FOCUS}`}>Show everybody</Link>}
        <p className="w-full text-sm text-muted-foreground" role="status">{users.length} of {allUsers.length} {allUsers.length === 1 ? 'person' : 'people'} shown.</p>
      </form>
      <div className="overflow-x-auto rounded-xl border bg-card">
        <table className={RT.table}>
          <caption className="sr-only">People of the organisation</caption>
          <thead className={RT.thead}>
            <tr>
              <th scope="col" className="px-3 py-2 font-medium">Person</th>
              <th scope="col" className="px-3 py-2 font-medium">Role</th>
              <th scope="col" className="px-3 py-2 font-medium">Status</th>
              {showSummary && <th scope="col" className="px-3 py-2 font-medium">Access in effect now</th>}
              <th scope="col" className="px-3 py-2"><span className="sr-only">Actions</span></th>
            </tr>
          </thead>
          <tbody className={RT.tbody}>
            {users.map((u) => (
              <UserRow
                key={u.id}
                showSummary={showSummary}
                allowedRoles={[...allowedRoles]}
                u={{
                  ...u, manageable: canManageRole(me.role, u.role), is_self: u.id === me.id, access_editable: accessEditable, summary: summaries?.get(u.id) ?? null,
                  two_step: twoStep ? (twoStep.get(u.id)?.factors ?? 0) > 0 : null, can_reset_two_step: me.role === 'platform_owner',
                  two_step_since: twoStep?.get(u.id)?.enrolledAt ?? null, two_step_from: twoStep?.get(u.id)?.enrolledIp ?? null,
                  code_lock: locks?.get(u.id) ?? null,
                }}
              />
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}
