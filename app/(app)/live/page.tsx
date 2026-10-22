import Link from 'next/link'
import { notFound } from 'next/navigation'
import { LayoutGrid, Video } from 'lucide-react'
import { LiveWall } from '@/components/live/LiveWall'
import { buttonVariants } from '@/components/ui/button'
import { EmptyState } from '@/components/ui/EmptyState'
import { PageHeader } from '@/components/ui/PageHeader'
import { requireCapability } from '@/lib/auth/profile'
import { storesForCapability } from '@/lib/queries/access'
import { listVisibleGroups } from '@/lib/queries/groups'
import { getLiveScope } from '@/lib/queries/live'
import { pickLocationParam } from '@/lib/queries/location-param'
import { createClient } from '@/lib/supabase/server'
import { cn } from '@/lib/utils'

export const metadata = { title: 'Live' }

const one = (v: string | string[] | undefined): string | undefined => (typeof v === 'string' && v !== '' ? v : undefined)

export default async function LivePage({ searchParams }: { searchParams: Promise<{ location?: string | string[]; store?: string | string[]; group?: string | string[]; camera?: string | string[] }> }) {
  const sp = await searchParams
  // ?location=<id> (links say this); the older ?store=<id> still works.
  const query = { store: pickLocationParam(sp) || undefined, group: one(sp.group), camera: one(sp.camera) }
  // P2-2: live video needs cctv.live; the wall shows only cameras the person may watch live (the database decides, per camera).
  const profile = await requireCapability('cctv.live')
  const supabase = await createClient()

  if (query.store || query.group || query.camera) {
    const scope = await getLiveScope(supabase, query, 'cctv.live')
    if (!scope) notFound()
    return (
      <div className="space-y-4">
        <PageHeader title={scope.title} description={scope.description} breadcrumbs={[{ label: 'Live', href: '/live' }, { label: scope.title }]} />
        {scope.cameras.length === 0 ? (
          <div className="rounded-xl border bg-card">
            <EmptyState icon={Video} title="No cameras to show" description="There are no working cameras here that you can watch live." />
          </div>
        ) : (
          <LiveWall cameras={scope.cameras} />
        )}
      </div>
    )
  }

  // Only locations and groups with a camera the person may watch live, counted that way.
  const [stores, groups] = await Promise.all([
    storesForCapability(supabase, profile.capabilities, 'cctv.live'),
    listVisibleGroups(supabase, { capabilities: profile.capabilities, capability: 'cctv.live' }),
  ])
  const withCameras = stores
  const usableGroups = groups.filter((g) => g.camera_count > 0)
  return (
    <div className="space-y-6">
      <PageHeader
        title="Live"
        description="Choose a location or a camera group to look at."
        actions={
          <Link href="/groups" className={cn(buttonVariants({ variant: 'outline', size: 'sm' }))}>
            <LayoutGrid aria-hidden="true" /> Camera groups
          </Link>
        }
      />

      <section aria-labelledby="live-groups" className="space-y-2">
        <h2 id="live-groups" className="text-sm font-semibold">Camera groups</h2>
        {usableGroups.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            No camera groups to show yet. <Link href="/groups" className="underline">Open camera groups</Link> to see or make one.
          </p>
        ) : (
          <ul className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
            {usableGroups.map((g) => (
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

      <section aria-labelledby="live-locations" className="space-y-2">
        <h2 id="live-locations" className="text-sm font-semibold">Locations</h2>
        {withCameras.length === 0 ? (
          <div className="rounded-xl border bg-card">
            <EmptyState icon={Video} title="No locations with cameras" description="You will see a location here once it has a working camera that you can watch live." />
          </div>
        ) : (
          <ul className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
            {withCameras.map((s) => (
              <li key={s.id}>
                <Link href={`/live?location=${encodeURIComponent(s.id)}`} className="flex flex-col rounded-lg border bg-card p-3 text-sm hover:bg-muted/50">
                  <span className="break-words font-medium"><span className="font-mono">{s.code}</span> · {s.name}</span>
                  <span className="text-muted-foreground">{[s.city, `${s.camera_count} ${s.camera_count === 1 ? 'camera' : 'cameras'}`].filter(Boolean).join(' · ')}</span>
                </Link>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  )
}
