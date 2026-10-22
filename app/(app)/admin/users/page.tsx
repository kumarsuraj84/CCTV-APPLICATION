import { CreateUserForm } from '@/components/admin/CreateUserForm'
import { UserRow } from '@/components/admin/UserRow'
import { PageHeader } from '@/components/ui/PageHeader'
import { canManageRole, ROLES } from '@/lib/admin/roles'
import { listStoresForAccess, listUsers } from '@/lib/admin/users'
import { requireAdmin } from '@/lib/auth/profile'
import { createAdminClient } from '@/lib/supabase/admin'

export const metadata = { title: 'Users' }

export default async function UsersPage() {
  const me = await requireAdmin()
  const admin = createAdminClient()
  const [users, stores] = await Promise.all([
    listUsers(admin, me.org_id),
    listStoresForAccess(admin, me.org_id),
  ])
  const allowedRoles = ROLES.filter((r) => canManageRole(me.role, r))
  return (
    <div className="space-y-6">
      <PageHeader title="Users" description="Add people and choose what they can see." />
      <CreateUserForm allowedRoles={[...allowedRoles]} stores={stores} />
      <div className="overflow-x-auto rounded-xl border bg-card">
        <table className="w-full text-sm">
          <thead className="bg-muted text-left text-xs uppercase text-muted-foreground">
            <tr><th className="px-3 py-2">Person</th><th className="px-3 py-2">Role</th><th className="px-3 py-2">Status</th><th className="px-3 py-2" /></tr>
          </thead>
          <tbody>
            {users.map((u) => (
              <UserRow
                key={u.id}
                u={{ ...u, manageable: canManageRole(me.role, u.role), is_self: u.id === me.id }}
              />
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}
