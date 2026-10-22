import Link from 'next/link'
import { notFound } from 'next/navigation'
import { GroupEditor } from '@/components/groups/GroupEditor'
import { buttonVariants } from '@/components/ui/button'
import { PageHeader } from '@/components/ui/PageHeader'
import { canManageGroups } from '@/lib/admin/roles'
import { requireProfile } from '@/lib/auth/profile'
import { LIVE_WALL_ENABLED, liveWallHref } from '@/lib/groups/live-wall'
import { listVisibleStores } from '@/lib/queries/inventory'
import { getVisibleGroup, listStoreCamerasForGroups } from '@/lib/queries/groups'
import { createClient } from '@/lib/supabase/server'
import { cn } from '@/lib/utils'

export const metadata = { title: 'Camera group' }

export default async function GroupPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ store?: string }> }) {
  const { id } = await params
  const { store } = await searchParams
  const profile = await requireProfile()
  const supabase = await createClient()
  const group = await getVisibleGroup(supabase, id)
  if (!group) notFound()

  const canManage = canManageGroups(profile.role)
  // The store list and the store's cameras are only needed by people who can add cameras.
  const stores = canManage ? await listVisibleStores(supabase) : []
  const selectedStoreId = canManage && typeof store === 'string' && store !== '' ? store : null
  const choices = selectedStoreId ? await listStoreCamerasForGroups(supabase, selectedStoreId, group.id) : null

  return (
    <div className="space-y-6">
      <PageHeader
        title={group.name}
        description={`${group.cameras.length} ${group.cameras.length === 1 ? 'camera' : 'cameras'} you can see`}
        breadcrumbs={[{ label: 'Camera groups', href: '/groups' }, { label: group.name }]}
        actions={LIVE_WALL_ENABLED && group.cameras.length > 0 ? <Link href={liveWallHref(group.id)} className={cn(buttonVariants())}>Open live wall</Link> : undefined}
      />
      <GroupEditor
        groupId={group.id}
        cameras={group.cameras}
        canManage={canManage}
        stores={stores.map((s) => ({ id: s.id, code: s.code, name: s.name }))}
        selectedStoreId={selectedStoreId}
        choices={choices}
      />
    </div>
  )
}
