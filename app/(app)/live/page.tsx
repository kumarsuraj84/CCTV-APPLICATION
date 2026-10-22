import Link from 'next/link'
import { notFound } from 'next/navigation'
import { ExternalLink, LayoutGrid, Search, Video } from 'lucide-react'
import { LiveTreeView } from '@/components/live/LiveTreeView'
import { LiveWall, type GroupTools } from '@/components/live/LiveWall'
import { StateDot } from '@/components/live/StateDot'
import { AutoRefresh } from '@/components/monitor/AutoRefresh'
import { buttonVariants } from '@/components/ui/button'
import { EmptyState } from '@/components/ui/EmptyState'
import { PageHeader, type Breadcrumb } from '@/components/ui/PageHeader'
import { hasGroupEditingAuthority } from '@/lib/admin/roles'
import { holds } from '@/lib/auth/capabilities'
import { requireCapability } from '@/lib/auth/profile'
import { CAMERA_STATE_LABEL, countsText, LIVE_STATUS_REFRESH_MS } from '@/lib/live/rollups'
import { getVisibleGroup, listVisibleGroups } from '@/lib/queries/groups'
import { getLiveScope, type LiveScopeKind } from '@/lib/queries/live'
import { loadLiveLanding, MIN_SEARCH } from '@/lib/queries/live-landing'
import { pickLocationParam } from '@/lib/queries/location-param'
import { maxStreamsPerUser } from '@/lib/streams/concurrency'
import { createClient } from '@/lib/supabase/server'
import { cn } from '@/lib/utils'

export const metadata = { title: 'Live' }

type Param = string | string[] | undefined
const one = (v: Param): string | undefined => (typeof v === 'string' && v !== '' ? v : undefined)

const KIND_LABEL: Record<LiveScopeKind, string> = { region: 'Region', cluster: 'Cluster', store: 'Location', nvr: 'NVR', group: 'Camera group', camera: 'Camera' }

export default async function LivePage({ searchParams }: {
  searchParams: Promise<{ location?: Param; store?: Param; group?: Param; camera?: Param; region?: Param; cluster?: Param; nvr?: Param; q?: Param; open?: Param }>
}) {
  const sp = await searchParams
  // ?location=<id> (links say this); the older ?store=<id> still works. P4-L1: also ?region, ?cluster and ?nvr (the NVR wall needs the
  // IT view of that NVR: for everybody else it does not exist).
  const query = { store: pickLocationParam(sp) || undefined, group: one(sp.group), camera: one(sp.camera), region: one(sp.region), cluster: one(sp.cluster), nvr: one(sp.nvr) }
  // P2-2: live video needs cctv.live; the wall shows only cameras the person may watch live (the database decides, per camera).
  const profile = await requireCapability('cctv.live')
  const supabase = await createClient()

  if (Object.values(query).some(Boolean)) {
    const scope = await getLiveScope(supabase, query, 'cctv.live')
    if (!scope) notFound()
    // LG-5: people who may change camera groups (the role AND live view) get "add to group" on every tile, and on a group's own wall
    // "remove" for its static members (members of a dynamic rule are not removed one by one). The actions check everything again.
    let groupTools: GroupTools | undefined
    if (hasGroupEditingAuthority(profile.role) && holds(profile.capabilities, 'cctv.live')) {
      const groups = await listVisibleGroups(supabase)
      groupTools = { editable: groups.map((g) => ({ id: g.id, name: g.name })) }
      if (scope.kind === 'group' && query.group) {
        const g = await getVisibleGroup(supabase, query.group)
        const onWall = new Set(scope.cameras.map((c) => c.id))
        if (g) groupTools.current = { id: g.id, removable: g.cameras.filter((c) => !c.from_rule && onWall.has(c.id)).map((c) => c.id) }
      }
    }
    const crumbs: Breadcrumb[] = [{ label: 'Live', href: '/live' }, { label: `${KIND_LABEL[scope.kind]}: ${scope.title}` }]
    return (
      <div className="space-y-4">
        <AutoRefresh busy={false} everyMs={LIVE_STATUS_REFRESH_MS} />
        <PageHeader title={scope.title} description={scope.description} breadcrumbs={crumbs} />
        {scope.cameras.length === 0 ? (
          <div className="rounded-xl border bg-card">
            <EmptyState icon={Video} title="No cameras to show" description="There are no working cameras here that you can watch live." />
          </div>
        ) : (
          <LiveWall cameras={scope.cameras} maxStreams={maxStreamsPerUser()} multiLocation={scope.multiLocation} groupTools={groupTools} />
        )}
      </div>
    )
  }

  // The landing: the person's own tree with roll-ups, their groups, and a search. Everything through their own client.
  const q = one(sp.q) ?? ''
  const landing = await loadLiveLanding(supabase, profile.capabilities, { q, open: one(sp.open) })
  const hasAnything = landing.totals.total > 0 || landing.groups.length > 0
  return (
    <div className="space-y-6">
      <AutoRefresh busy={false} everyMs={LIVE_STATUS_REFRESH_MS} />
      <PageHeader
        title="Live"
        description="Choose a region, cluster, location, NVR, camera group or camera to watch."
        actions={
          <Link href="/groups" className={cn(buttonVariants({ variant: 'outline', size: 'sm' }))}>
            <LayoutGrid aria-hidden="true" /> Camera groups
          </Link>
        }
      />

      <form role="search" action="/live" className="flex max-w-xl gap-2">
        <label htmlFor="live-search" className="sr-only">Search locations and cameras</label>
        <input
          id="live-search"
          name="q"
          defaultValue={q}
          placeholder="Location code or name, or camera name"
          className="h-9 w-full rounded-lg border border-[var(--field-border)] bg-[var(--field)] px-3 text-sm"
        />
        <button type="submit" className={cn(buttonVariants({ size: 'sm' }), 'h-9')}><Search aria-hidden="true" /> Search</button>
        {q && <Link href="/live" className={cn(buttonVariants({ variant: 'outline', size: 'sm' }), 'h-9')}>Clear</Link>}
      </form>

      {landing.totals.total > 0 && (
        <p className="text-sm text-muted-foreground" aria-live="polite">
          {countsText(landing.totals)}. Updated every minute.
        </p>
      )}

      {q.length >= MIN_SEARCH && (
        <section aria-labelledby="live-camera-matches" className="space-y-2">
          <h2 id="live-camera-matches" className="text-sm font-semibold">Cameras matching “{q}”</h2>
          {landing.cameraMatches.length === 0 ? (
            <p className="text-sm text-muted-foreground">No camera you can watch live has that in its name.</p>
          ) : (
            <ul className="divide-y rounded-xl border bg-card">
              {landing.cameraMatches.map((c) => (
                <li key={c.id} className="flex flex-wrap items-center justify-between gap-2 px-3 py-2 text-sm">
                  <span className="flex min-w-0 items-center gap-2">
                    <StateDot state={c.state} />
                    <Link href={`/live?camera=${encodeURIComponent(c.id)}`} className="break-words underline-offset-2 hover:underline">{c.name}</Link>
                    <span translate="no" className="font-mono text-xs text-muted-foreground">{c.locationCode}</span>
                    <span className="text-xs text-muted-foreground">{CAMERA_STATE_LABEL[c.state]}</span>
                  </span>
                  <a href={`/live?camera=${encodeURIComponent(c.id)}`} target="_blank" rel="noopener" className={cn(buttonVariants({ variant: 'outline', size: 'sm' }))} aria-label={`Open ${c.name} in a new window`}>
                    <ExternalLink aria-hidden="true" /> New window
                  </a>
                </li>
              ))}
            </ul>
          )}
        </section>
      )}

      <section aria-labelledby="live-groups" className="space-y-2">
        <h2 id="live-groups" className="text-sm font-semibold">Camera groups</h2>
        {landing.groups.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            No camera groups to show yet. <Link href="/groups" className="underline">Open camera groups</Link> to see or make one.
          </p>
        ) : (
          <ul className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
            {landing.groups.map((g) => (
              <li key={g.id}>
                <Link href={`/live?group=${encodeURIComponent(g.id)}`} className="flex flex-col rounded-lg border bg-card p-3 text-sm hover:bg-muted/50">
                  <span className="break-words font-medium">{g.name}</span>
                  <span className="text-muted-foreground">{g.camera_count} {g.camera_count === 1 ? 'camera' : 'cameras'} you can watch</span>
                </Link>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section aria-labelledby="live-places" className="space-y-2">
        <h2 id="live-places" className="text-sm font-semibold">Regions, clusters and locations</h2>
        {!hasAnything && !q ? (
          <div className="rounded-xl border bg-card">
            <EmptyState icon={Video} title="No locations with cameras" description="You will see a location here once it has a working camera that you can watch live." />
          </div>
        ) : (
          <LiveTreeView tree={landing.tree} branch={landing.branch} openId={one(sp.open) ?? null} query={q} />
        )}
      </section>
    </div>
  )
}
