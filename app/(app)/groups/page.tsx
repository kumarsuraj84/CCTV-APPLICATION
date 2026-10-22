import Link from 'next/link'
import { LayoutGrid } from 'lucide-react'
import { DeleteButton } from '@/components/admin/DeleteButton'
import { CreateGroupForm } from '@/components/groups/CreateGroupForm'
import { buttonVariants } from '@/components/ui/button'
import { EmptyState } from '@/components/ui/EmptyState'
import { PageHeader } from '@/components/ui/PageHeader'
import { deleteGroupAction } from '@/lib/actions/groups'
import { canManageGroups, isAdminRole } from '@/lib/admin/roles'
import { requireProfile } from '@/lib/auth/profile'
import { LIVE_WALL_ENABLED, liveWallHref } from '@/lib/groups/live-wall'
import { listVisibleGroups } from '@/lib/queries/groups'
import { cn } from '@/lib/utils'
import { createClient } from '@/lib/supabase/server'

export const metadata = { title: 'Camera groups' }

export default async function GroupsPage() {
  const profile = await requireProfile()
  const supabase = await createClient()
  const groups = await listVisibleGroups(supabase)
  const canManage = canManageGroups(profile.role)
  return (
    <div className="space-y-4">
      <PageHeader title="Camera groups" description="Sets of cameras you can look at together, for example all the entrance doors." />
      {canManage && <CreateGroupForm />}
      {groups.length === 0 ? (
        <div className="rounded-xl border bg-card">
          <EmptyState
            icon={LayoutGrid}
            title="No camera groups yet"
            description={canManage ? 'Make a group above, then add cameras to it.' : 'You will see a group here once an operator or administrator makes one that includes a camera you can see.'}
          />
        </div>
      ) : (
        <ul className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
          {groups.map((g) => {
            const mayDelete = canManage && (isAdminRole(profile.role) || g.created_by === profile.id)
            return (
              <li key={g.id} className="flex flex-col gap-2 rounded-lg border bg-card p-3 text-sm">
                <div className="min-w-0">
                  <Link href={`/groups/${g.id}`} className="break-words font-medium underline">{g.name}</Link>
                  <div className="text-muted-foreground">
                    {g.camera_count === 0 ? 'No cameras you can see' : `${g.camera_count} ${g.camera_count === 1 ? 'camera' : 'cameras'} you can see`}
                  </div>
                </div>
                <div className="flex flex-wrap items-center gap-2">
                  {LIVE_WALL_ENABLED && g.camera_count > 0 && (
                    <Link href={liveWallHref(g.id)} className={cn(buttonVariants({ size: 'sm' }))}>Open live wall</Link>
                  )}
                  <Link href={`/groups/${g.id}`} className={cn(buttonVariants({ size: 'sm', variant: 'outline' }))}>{canManage ? 'Open and change' : 'Open'}</Link>
                  {mayDelete && <DeleteButton label="Delete group" onDelete={deleteGroupAction.bind(null, g.id)} />}
                </div>
              </li>
            )
          })}
        </ul>
      )}
    </div>
  )
}
