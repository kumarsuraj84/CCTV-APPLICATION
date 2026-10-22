import Link from 'next/link'
import { notFound } from 'next/navigation'
import { GroupEditor } from '@/components/groups/GroupEditor'
import { buttonVariants } from '@/components/ui/button'
import { PageHeader } from '@/components/ui/PageHeader'
import { hasGroupEditingAuthority } from '@/lib/admin/roles'
import { CCTV_CAPABILITIES, holds } from '@/lib/auth/capabilities'
import { requireCapability } from '@/lib/auth/profile'
import { LIVE_WALL_ENABLED, liveWallHref } from '@/lib/groups/live-wall'
import { storesForCapability } from '@/lib/queries/access'
import { getVisibleGroup, listStoreCamerasForGroups } from '@/lib/queries/groups'
import { camerasFor } from '@/lib/auth/resource'
import { createClient } from '@/lib/supabase/server'
import { cn } from '@/lib/utils'

export const metadata = { title: 'Camera group' }

export default async function GroupPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ store?: string }> }) {
  const { id } = await params
  const { store } = await searchParams
  const profile = await requireCapability(CCTV_CAPABILITIES)
  const supabase = await createClient()
  const group = await getVisibleGroup(supabase, id)
  if (!group) notFound()

  // P2-2: changing the group needs the role AND cctv.live; only cameras the person may watch live can be added (the action checks each
  // one again in the database), so the store list and the choices hold only those. The live wall needs a camera they may watch live.
  const live = holds(profile.capabilities, 'cctv.live')
  const canManage = hasGroupEditingAuthority(profile.role) && live
  const stores = canManage ? await storesForCapability(supabase, profile.capabilities, 'cctv.live') : []
  const selectedStoreId = canManage && typeof store === 'string' && store !== '' ? store : null
  const visibleChoices = selectedStoreId ? await listStoreCamerasForGroups(supabase, selectedStoreId, group.id) : null
  let choices = visibleChoices
  if (visibleChoices) {
    const allowed = await camerasFor(supabase, 'cctv.live', visibleChoices.map((c) => c.id))
    const ok = new Set(allowed.ok ? allowed.ids : [])
    choices = visibleChoices.filter((c) => ok.has(c.id.toLowerCase()))
  }
  const watchable = live ? await camerasFor(supabase, 'cctv.live', group.cameras.map((c) => c.id)) : { ok: true as const, ids: [] }
  const canOpenWall = watchable.ok && watchable.ids.length > 0

  return (
    <div className="space-y-6">
      <PageHeader
        title={group.name}
        description={`${group.cameras.length} ${group.cameras.length === 1 ? 'camera' : 'cameras'} you can see`}
        breadcrumbs={[{ label: 'Camera groups', href: '/groups' }, { label: group.name }]}
        actions={LIVE_WALL_ENABLED && canOpenWall ? <Link href={liveWallHref(group.id)} className={cn(buttonVariants())}>Open live wall</Link> : undefined}
      />
      <GroupEditor
        groupId={group.id}
        cameras={group.cameras}
        canManage={canManage}
        stores={stores.map((s) => ({ id: s.id, code: s.code, name: s.name }))}
        selectedStoreId={selectedStoreId}
        choices={choices}
        removableIds={watchable.ok ? watchable.ids : []}
      />
    </div>
  )
}
