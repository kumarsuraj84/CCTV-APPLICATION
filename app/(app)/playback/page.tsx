import Link from 'next/link'
import { notFound } from 'next/navigation'
import { History, Video } from 'lucide-react'
import { PlaybackView } from '@/components/live/PlaybackView'
import { StatusBadge } from '@/components/monitor/StatusBadge'
import { buttonVariants } from '@/components/ui/button'
import { EmptyState } from '@/components/ui/EmptyState'
import { PageHeader } from '@/components/ui/PageHeader'
import { holds } from '@/lib/auth/capabilities'
import { requireCapability } from '@/lib/auth/profile'
import { cameraFor } from '@/lib/auth/resource'
import { storesForCapability } from '@/lib/queries/access'
import { getLiveScope } from '@/lib/queries/live'
import { pickLocationParam } from '@/lib/queries/location-param'
import { parseDay, shownToday } from '@/lib/streams/timeline'
import { FAST_PLAYBACK_CAPABILITY } from '@/lib/streams/speed'
import { fastPlaybackAvailable } from '@/lib/streams/vod'
import { createClient } from '@/lib/supabase/server'
import { cn } from '@/lib/utils'

export const metadata = { title: 'Playback' }

const one = (v: string | string[] | undefined): string | undefined => (typeof v === 'string' && v !== '' ? v : undefined)

// Choose a location, then a camera of it (only what this person may see), then look at its recordings.
// ?camera=<id>[&day=yyyy-mm-dd] opens a camera directly; ?location=<id> lists the cameras of a location (the older ?store=<id> still works).
export default async function PlaybackPage({ searchParams }: { searchParams: Promise<{ location?: string | string[]; store?: string | string[]; camera?: string | string[]; day?: string | string[] }> }) {
  const sp = await searchParams
  const storeId = pickLocationParam(sp) || undefined
  const cameraId = one(sp.camera)
  // P2-2: recordings need cctv.playback; the lists hold only cameras the person may play back (the database decides, per camera).
  const profile = await requireCapability('cctv.playback')
  const supabase = await createClient()
  const today = shownToday(new Date().getTime())

  if (cameraId) {
    const scope = await getLiveScope(supabase, { camera: cameraId }, 'cctv.playback')
    const camera = scope?.cameras[0]
    if (!scope || !camera) notFound()
    const day = one(sp.day)
    // Fast playback (2x, 4x, 8x) is a savable file: offered only with cctv.export for this camera (D-6a), and it needs ffmpeg on the
    // server (the answer is remembered for a minute). Everybody else sees 1x and nothing about ffmpeg.
    const exportable = holds(profile.capabilities, FAST_PLAYBACK_CAPABILITY) ? await cameraFor(supabase, FAST_PLAYBACK_CAPABILITY, camera.id) : null
    const fastPlayback = !(exportable?.ok && exportable.allowed) ? 'hidden' : (await fastPlaybackAvailable()) ? 'available' : 'not-set-up'
    return (
      <div className="space-y-4">
        <PageHeader
          title={`Playback · ${camera.name}`}
          description={scope.description}
          breadcrumbs={[{ label: 'Playback', href: '/playback' }, { label: `${camera.storeCode} · ${camera.name}` }]}
          actions={
            camera.canLive ? (
              <Link href={`/live?camera=${encodeURIComponent(camera.id)}`} className={cn(buttonVariants({ variant: 'outline' }))}>
                <Video aria-hidden="true" /> Watch live
              </Link>
            ) : undefined
          }
        />
        <PlaybackView camera={{ id: camera.id, name: camera.name, storeCode: camera.storeCode }} today={today} initialDay={parseDay(day) ? day! : today} fastPlayback={fastPlayback} />
      </div>
    )
  }

  if (storeId) {
    const scope = await getLiveScope(supabase, { store: storeId }, 'cctv.playback')
    if (!scope) notFound()
    return (
      <div className="space-y-4">
        <PageHeader title={`Playback · ${scope.title}`} description="Choose a camera." breadcrumbs={[{ label: 'Playback', href: '/playback' }, { label: scope.title }]} />
        {scope.cameras.length === 0 ? (
          <div className="rounded-xl border bg-card">
            <EmptyState icon={Video} title="No cameras to show" description="There are no working cameras here whose recordings you can play back." />
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

  const stores = await storesForCapability(supabase, profile.capabilities, 'cctv.playback')
  return (
    <div className="space-y-4">
      <PageHeader title="Playback" description="Choose a location, then a camera, to look at its recordings." />
      {stores.length === 0 ? (
        <div className="rounded-xl border bg-card">
          <EmptyState icon={History} title="No locations with cameras" description="You will see a location here once it has a working camera whose recordings you can play back." />
        </div>
      ) : (
        <ul className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
          {stores.map((s) => (
            <li key={s.id}>
              <Link href={`/playback?location=${encodeURIComponent(s.id)}`} className="flex flex-col rounded-lg border bg-card p-3 text-sm hover:bg-muted/50">
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
