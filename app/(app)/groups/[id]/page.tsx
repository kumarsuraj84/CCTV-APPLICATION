import Link from 'next/link'
import { notFound } from 'next/navigation'
import { GroupEditor } from '@/components/groups/GroupEditor'
import { GroupRules } from '@/components/groups/GroupRules'
import { listGroupRules } from '@/lib/groups/service'
import { createAdminClient } from '@/lib/supabase/admin'
import { buttonVariants } from '@/components/ui/button'
import { PageHeader } from '@/components/ui/PageHeader'
import { hasGroupEditingAuthority } from '@/lib/admin/roles'
import { CCTV_CAPABILITIES, holds } from '@/lib/auth/capabilities'
import { requireCapability } from '@/lib/auth/profile'
import { LIVE_WALL_ENABLED, liveWallHref } from '@/lib/groups/live-wall'
import { storesForCapability } from '@/lib/queries/access'
import { getVisibleGroup, listStoreCamerasForGroups } from '@/lib/queries/groups'
import { pickLocationParam } from '@/lib/queries/location-param'
import { camerasFor } from '@/lib/auth/resource'
import { createClient } from '@/lib/supabase/server'
import { cn } from '@/lib/utils'

export const metadata = { title: 'Camera group' }

export default async function GroupPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ location?: string | string[]; store?: string | string[] }> }) {
  const { id } = await params
  const sp = await searchParams
  const profile = await requireCapability(CCTV_CAPABILITIES)
  const supabase = await createClient()
  const group = await getVisibleGroup(supabase, id)
  if (!group) notFound()

  // P2-2: changing the group needs the role AND cctv.live; only cameras the person may watch live can be added (the action checks each
  // one again in the database), so the location list and the choices hold only those. The live wall needs a camera they may watch live.
  const live = holds(profile.capabilities, 'cctv.live')
  const canManage = hasGroupEditingAuthority(profile.role) && live
  const stores = canManage ? await storesForCapability(supabase, profile.capabilities, 'cctv.live') : []
  // ?location=<id> (the form says this); the older ?store=<id> still works.
  const chosen = pickLocationParam(sp)
  const selectedStoreId = canManage && chosen !== '' ? chosen : null
  const visibleChoices = selectedStoreId ? await listStoreCamerasForGroups(supabase, selectedStoreId, group.id) : null
  let choices = visibleChoices
  if (visibleChoices) {
    const allowed = await camerasFor(supabase, 'cctv.live', visibleChoices.map((c) => c.id))
    const ok = new Set(allowed.ok ? allowed.ids : [])
    choices = visibleChoices.filter((c) => ok.has(c.id.toLowerCase()))
  }
  const watchable = live ? await camerasFor(supabase, 'cctv.live', group.cameras.map((c) => c.id)) : { ok: true as const, ids: [] }
  const canOpenWall = watchable.ok && watchable.ids.length > 0
  // P2-5c-1: dynamic rules, for the people who may change the group. Places are offered from what the person can see (their own
  // client); adding a rule checks live view of the whole place again in the database.
  const actor = { id: profile.id, orgId: profile.org_id, role: profile.role }
  const rules = canManage ? await listGroupRules({ admin: createAdminClient(), rls: supabase }, actor, group.id) : null
  const places = canManage ? await rulePlaces(supabase, stores) : null

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
      {canManage && rules?.ok && places && <GroupRules groupId={group.id} rules={rules.rules} places={places} />}
    </div>
  )
}

/** The places a rule may name, from what the person can see (regions, clusters, locations with live view, NVRs with the IT view). */
async function rulePlaces(supabase: Awaited<ReturnType<typeof createClient>>, stores: { id: string; code: string; name: string }[]) {
  const [regions, clusters, recorders] = await Promise.all([
    // Review M-9: archived regions and clusters are never offered (a rule on them would match nothing).
    supabase.from('regions').select('id, code, name').is('archived_at', null).order('code'),
    supabase.from('clusters').select('id, code, name').is('archived_at', null).order('code'),
    supabase.from('recorders').select('id, location_id').order('location_id'),
  ])
  const recIds = (recorders.data ?? []).map((r) => r.id)
  const { data: names } = recIds.length ? await supabase.from('assets').select('id, name').in('id', recIds) : { data: [] }
  const name = new Map((names ?? []).map((n) => [n.id, n.name]))
  const code = new Map(stores.map((s) => [s.id, s.code]))
  return {
    region: (regions.data ?? []).map((r) => ({ id: r.id, label: `${r.code} · ${r.name}` })),
    cluster: (clusters.data ?? []).map((c) => ({ id: c.id, label: `${c.code} · ${c.name}` })),
    location: stores.map((s) => ({ id: s.id, label: `${s.code} · ${s.name}` })),
    recorder: (recorders.data ?? []).filter((r) => name.has(r.id)).map((r) => ({ id: r.id, label: `${code.get(r.location_id) ?? ''} · ${name.get(r.id)}` })),
  }
}
