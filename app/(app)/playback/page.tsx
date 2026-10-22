import Link from 'next/link'
import { notFound } from 'next/navigation'
import { History, Video } from 'lucide-react'
import { PlaybackView } from '@/components/live/PlaybackView'
import { StatusBadge } from '@/components/monitor/StatusBadge'
import { buttonVariants } from '@/components/ui/button'
import { EmptyState } from '@/components/ui/EmptyState'
import { PageHeader } from '@/components/ui/PageHeader'
import { requireProfile } from '@/lib/auth/profile'
import { listVisibleStores } from '@/lib/queries/inventory'
import { getLiveScope } from '@/lib/queries/live'
import { parseDay, shownToday } from '@/lib/streams/timeline'
import { canUseFastPlaybackInterim } from '@/lib/streams/speed'
import { fastPlaybackAvailable } from '@/lib/streams/vod'
import { createClient } from '@/lib/supabase/server'
import { cn } from '@/lib/utils'

export const metadata = { title: 'Playback' }

const one = (v: string | string[] | undefined): string | undefined => (typeof v === 'string' && v !== '' ? v : undefined)

// Choose a store, then a camera of it (only what this person may see), then look at its recordings.
// ?camera=<id>[&day=yyyy-mm-dd] opens a camera directly; ?store=<id> lists the cameras of a store.
export default async function PlaybackPage({ searchParams }: { searchParams: Promise<{ store?: string | string[]; camera?: string | string[]; day?: string | string[] }> }) {
  const sp = await searchParams
  const storeId = one(sp.store)
  const cameraId = one(sp.camera)
  const profile = await requireProfile()
  const supabase = await createClient()
  const today = shownToday(new Date().getTime())

  if (cameraId) {
    const scope = await getLiveScope(supabase, { camera: cameraId })
    const camera = scope?.cameras[0]
    if (!scope || !camera) notFound()
    const day = one(sp.day)
    // Fast playback (2x, 4x, 8x) needs ffmpeg on the server; the answer is remembered for a minute.
    // Interim: only administrators are offered it; everybody else sees 1x and nothing about ffmpeg.
    const fastPlayback = !canUseFastPlaybackInterim(profile.role) ? 'hidden' : (await fastPlaybackAvailable()) ? 'available' : 'not-set-up'
    return (
      <div className="space-y-4">
        <PageHeader
          title={`Playback · ${camera.name}`}
          description={scope.description}
          breadcrumbs={[{ label: 'Playback', href: '/playback' }, { label: `${camera.storeCode} · ${camera.name}` }]}
          actions={
            <Link href={`/live?camera=${encodeURIComponent(camera.id)}`} className={cn(buttonVariants({ variant: 'outline' }))}>
              <Video aria-hidden="true" /> Watch live
            </Link>
          }
        />
        <PlaybackView camera={{ id: camera.id, name: camera.name, storeCode: camera.storeCode }} today={today} initialDay={parseDay(day) ? day! : today} fastPlayback={fastPlayback} />
      </div>
    )
  }

  if (storeId) {
    const scope = await getLiveScope(supabase, { store: storeId })
    if (!scope) notFound()
    return (
      <div className="space-y-4">
        <PageHeader title={`Playback · ${scope.title}`} description="Choose a camera." breadcrumbs={[{ label: 'Playback', href: '/playback' }, { label: scope.title }]} />
        {scope.cameras.length === 0 ? (
          <div className="rounded-xl border bg-card">
            <EmptyState icon={Video} title="No cameras to show" description="There are no working cameras here that you can see." />
          </div>
        ) : (
          <ul className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
            {scope.cameras.map((c) => (
              <li key={c.id}>
                <Link href={`/playback?camera=${encodeURIComponent(c.id)}`} className="flex items-center justify-between gap-2 rounded-lg border bg-card p-3 text-sm hover:bg-muted/50">
                  <span className="min-w-0 break-words font-medium">{c.channel} · {c.name}</span>
                  <StatusBadge status={c.status} stale={c.stale} className="shrink-0" />
                </Link>
              </li>
            ))}
          </ul>
        )}
      </div>
    )
  }

  const stores = (await listVisibleStores(supabase)).filter((s) => s.camera_count > 0)
  return (
    <div className="space-y-4">
      <PageHeader title="Playback" description="Choose a store, then a camera, to look at its recordings." />
      {stores.length === 0 ? (
        <div className="rounded-xl border bg-card">
          <EmptyState icon={History} title="No stores with cameras" description="You will see a store here once it has a working camera that you can see." />
        </div>
      ) : (
        <ul className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
          {stores.map((s) => (
            <li key={s.id}>
              <Link href={`/playback?store=${encodeURIComponent(s.id)}`} className="flex flex-col rounded-lg border bg-card p-3 text-sm hover:bg-muted/50">
                <span className="break-words font-medium"><span className="font-mono">{s.code}</span> · {s.name}</span>
                <span className="text-muted-foreground">{[s.city, `${s.camera_count} ${s.camera_count === 1 ? 'camera' : 'cameras'}`].filter(Boolean).join(' · ')}</span>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
