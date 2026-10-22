import Link from 'next/link'
import { ExternalLink, History, LayoutGrid, MapPin } from 'lucide-react'
import { CAMERA_STATE_LABEL, countsText, nodeState, recorderText, type CameraCounts, type RecorderCounts } from '@/lib/live/rollups'
import type { LiveTree, TreeCluster, TreeLocation } from '@/lib/live/tree'
import type { LandingBranch, LandingCamera } from '@/lib/queries/live-landing'
import { statusLabel } from '@/lib/queries/status'
import { cn } from '@/lib/utils'
import { StateDot } from './StateDot'

// P4-L1 brief item 1 (LG-1, LG-7): the viewer's own Region → Cluster → Location tree on the Live landing, server-rendered from what
// the person may see. Regions and clusters fold open and shut (details); a location opens in place (?open=<id>) with its cameras, and
// — only for people with the IT view of them — its NVRs, each with its own wall. Every node says its counts in words next to the dot.

const wallLink = 'inline-flex items-center gap-1 rounded-md border border-[var(--field-border)] bg-card px-2 py-1 text-xs font-medium hover:bg-muted focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--ring)]'

function Counts({ counts, recorders }: { counts: CameraCounts; recorders: RecorderCounts | null }) {
  const nvr = recorderText(recorders)
  return (
    <span className="text-xs text-muted-foreground">
      {countsText(counts)}
      {nvr ? ` · ${nvr}` : ''}
    </span>
  )
}

function openHref(id: string | null, query: string): string {
  const p = new URLSearchParams()
  if (query) p.set('q', query)
  if (id) p.set('open', id)
  const s = p.toString()
  return `${s ? `/live?${s}` : '/live'}${id ? `#loc-${id}` : ''}`
}

function CameraRow({ c }: { c: LandingCamera }) {
  return (
    <li className="flex flex-wrap items-center justify-between gap-2 px-3 py-1.5 text-sm">
      <span className="flex min-w-0 items-center gap-2">
        <StateDot state={c.state} />
        <Link href={`/live?camera=${encodeURIComponent(c.id)}`} className="min-w-0 break-words underline-offset-2 hover:underline">{c.name}</Link>
        <span className="text-xs text-muted-foreground">{CAMERA_STATE_LABEL[c.state]}</span>
      </span>
      <span className="flex shrink-0 items-center gap-1">
        <a href={`/live?camera=${encodeURIComponent(c.id)}`} target="_blank" rel="noopener" className={wallLink} aria-label={`Open ${c.name} in a new window`}>
          <ExternalLink aria-hidden="true" className="size-3.5" /> New window
        </a>
        {c.canPlayback && (
          <Link href={`/playback?camera=${encodeURIComponent(c.id)}`} className={wallLink} aria-label={`Play back ${c.name}`}>
            <History aria-hidden="true" className="size-3.5" /> Playback
          </Link>
        )}
      </span>
    </li>
  )
}

function Branch({ branch }: { branch: LandingBranch }) {
  const byId = new Map(branch.cameras.map((c) => [c.id, c]))
  if (branch.recorders && branch.recorders.length > 0) {
    const placed = new Set(branch.recorders.flatMap((r) => r.cameraIds))
    const rest = branch.cameras.filter((c) => !placed.has(c.id))
    return (
      <div className="space-y-2 border-t bg-muted/30 px-2 py-2">
        {branch.recorders.map((r) => (
          <div key={r.id} className="rounded-lg border bg-card">
            <div className="flex flex-wrap items-center justify-between gap-2 px-3 py-2">
              <span className="flex min-w-0 items-center gap-2 text-sm font-medium">
                <StateDot state={r.status === 'down' ? 'offline' : r.status === 'off' ? 'off' : r.status === 'up' && !r.stale ? 'live' : 'not_checked'} />
                <span className="break-words">{r.name}</span>
                <span className="text-xs font-normal text-muted-foreground">NVR · {statusLabel(r.status, r.stale)} · {r.cameraIds.length} {r.cameraIds.length === 1 ? 'camera' : 'cameras'}</span>
              </span>
              {r.cameraIds.length > 0 && (
                <Link href={`/live?nvr=${encodeURIComponent(r.id)}`} className={wallLink}><LayoutGrid aria-hidden="true" className="size-3.5" /> Open wall</Link>
              )}
            </div>
            <ul className="divide-y border-t">{r.cameraIds.map((id) => byId.get(id)).filter((c): c is LandingCamera => !!c).map((c) => <CameraRow key={c.id} c={c} />)}</ul>
          </div>
        ))}
        {rest.length > 0 && <ul className="divide-y rounded-lg border bg-card">{rest.map((c) => <CameraRow key={c.id} c={c} />)}</ul>}
      </div>
    )
  }
  return <ul className="divide-y border-t bg-muted/30">{branch.cameras.map((c) => <CameraRow key={c.id} c={c} />)}</ul>
}

function LocationRow({ l, branch, openId, query }: { l: TreeLocation; branch: LandingBranch | null; openId: string | null; query: string }) {
  const isOpen = openId === l.id && branch?.location.id === l.id
  return (
    <li id={`loc-${l.id}`} className="scroll-mt-20">
      <div className="flex flex-wrap items-center justify-between gap-2 px-3 py-2">
        <span className="flex min-w-0 items-center gap-2">
          <StateDot state={nodeState(l.counts)} />
          <Link href={openHref(isOpen ? null : l.id, query)} scroll={false} aria-expanded={isOpen} className="min-w-0 break-words text-sm font-medium underline-offset-2 hover:underline">
            <span translate="no" className="font-mono">{l.code}</span> · {l.name}
          </Link>
          {l.city && <span className="text-xs text-muted-foreground">{l.city}</span>}
        </span>
        <span className="flex flex-wrap items-center gap-2">
          <Counts counts={l.counts} recorders={l.recorders} />
          <Link href={`/live?location=${encodeURIComponent(l.id)}`} className={wallLink}><LayoutGrid aria-hidden="true" className="size-3.5" /> Open wall</Link>
        </span>
      </div>
      {isOpen && branch && <Branch branch={branch} />}
    </li>
  )
}

function ClusterBlock({ c, branch, openId, query, open }: { c: TreeCluster; branch: LandingBranch | null; openId: string | null; query: string; open: boolean }) {
  return (
    <div className="relative">
      <details open={open || c.locations.some((l) => l.id === openId)} className="group/cl rounded-lg border bg-card">
        <summary className={cn(summaryClass, 'py-2')}>
          <span className="flex min-w-0 items-center gap-2 text-sm font-semibold">
            <StateDot state={nodeState(c.counts)} />
            <span className="break-words"><span translate="no" className="font-mono">{c.code}</span> · {c.name}</span>
            <span className="text-xs font-normal text-muted-foreground">Cluster · {c.locations.length} {c.locations.length === 1 ? 'location' : 'locations'}</span>
          </span>
          <Counts counts={c.counts} recorders={c.recorders} />
        </summary>
        <ul className="divide-y border-t">{c.locations.map((l) => <LocationRow key={l.id} l={l} branch={branch} openId={openId} query={query} />)}</ul>
      </details>
      <Link href={`/live?cluster=${encodeURIComponent(c.id)}`} className={cn(wallLink, wallLinkPlace)} aria-label={`Open the wall of ${c.code} · ${c.name}`}>
        <LayoutGrid aria-hidden="true" className="size-3.5" /> Open wall
      </Link>
    </div>
  )
}

// The toggle leaves room on the right for the wall link, which is placed over that corner (outside the <summary>; review M-10).
const summaryClass = 'flex cursor-pointer list-none flex-wrap items-center justify-between gap-2 py-2 pl-3 pr-32 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--ring)]'
const wallLinkPlace = 'absolute right-3 top-2'

export function LiveTreeView({ tree, branch, openId, query }: { tree: LiveTree; branch: LandingBranch | null; openId: string | null; query: string }) {
  const empty = tree.regions.length === 0 && tree.clusters.length === 0 && tree.locations.length === 0
  if (empty) {
    return (
      <p className="rounded-xl border bg-card px-4 py-6 text-center text-sm text-muted-foreground">
        {query ? `No location matches “${query}”.` : 'No locations with cameras you can watch live yet.'}
      </p>
    )
  }
  // A search opens everything it found; one region opens by itself.
  const openAll = query !== '' || tree.regions.length + tree.clusters.length <= 1
  return (
    <div className="space-y-3">
      {tree.regions.map((r) => (
        <div key={r.id} className="relative">
          <details open={openAll || r.clusters.some((c) => c.locations.some((l) => l.id === openId))} className="rounded-xl border bg-card">
            {/* Review M-10: only text inside the toggle; the wall link sits next to it (outside <summary>). */}
            <summary className={cn(summaryClass, 'py-2.5')}>
              <span className="flex min-w-0 items-center gap-2 font-semibold">
                <StateDot state={nodeState(r.counts)} />
                <span className="break-words"><span translate="no" className="font-mono">{r.code}</span> · {r.name}</span>
                <span className="text-xs font-normal text-muted-foreground">Region · {r.clusters.length} {r.clusters.length === 1 ? 'cluster' : 'clusters'}</span>
              </span>
              <Counts counts={r.counts} recorders={r.recorders} />
            </summary>
            <div className="space-y-2 border-t p-2">
              {r.clusters.map((c) => <ClusterBlock key={c.id} c={c} branch={branch} openId={openId} query={query} open={openAll} />)}
            </div>
          </details>
          <Link href={`/live?region=${encodeURIComponent(r.id)}`} className={cn(wallLink, wallLinkPlace)} aria-label={`Open the wall of ${r.code} · ${r.name}`}>
            <LayoutGrid aria-hidden="true" className="size-3.5" /> Open wall
          </Link>
        </div>
      ))}
      {tree.clusters.map((c) => <ClusterBlock key={c.id} c={c} branch={branch} openId={openId} query={query} open={openAll} />)}
      {tree.locations.length > 0 && (
        <section aria-label="Other locations" className={cn('rounded-xl border bg-card')}>
          {(tree.regions.length > 0 || tree.clusters.length > 0) && (
            <p className="flex items-center gap-2 border-b px-3 py-2 text-xs text-muted-foreground"><MapPin aria-hidden="true" className="size-3.5" /> Locations not in a cluster you can see</p>
          )}
          <ul className="divide-y">{tree.locations.map((l) => <LocationRow key={l.id} l={l} branch={branch} openId={openId} query={query} />)}</ul>
        </section>
      )}
    </div>
  )
}
