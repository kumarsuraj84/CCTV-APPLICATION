import Link from 'next/link'
import { countsText, nodeState, recorderText, type RollupCard } from '@/lib/live/rollups'
import { StateDot } from './StateDot'

export type { RollupCard }

// P4-L1 brief item 1 (and LG-19): the Home dashboard's roll-up cards per region or cluster — camera counts in words (live, offline,
// recorder not reachable, not checked, switched off) and, only with the IT view of the NVRs there, how many NVRs are down. A card opens
// the live wall of that place only when the person may watch a camera of it live (it has a status_rollups('cctv.live') row); otherwise
// it is not a link.

const problemsFirst = (a: RollupCard, b: RollupCard) =>
  (b.counts.offline + b.counts.recorderUnreachable) - (a.counts.offline + a.counts.recorderUnreachable) || a.code.localeCompare(b.code) || a.id.localeCompare(b.id)

/** `liveIds`: the nodes with a camera the person may watch live (review M-12): only those cards open a wall. */
export function RollupCards({ title, level, rows, liveIds }: { title: string; level: 'region' | 'cluster'; rows: RollupCard[]; liveIds: ReadonlySet<string> }) {
  if (rows.length === 0) return null
  const id = `rollups-${level}`
  return (
    <section aria-labelledby={id} className="space-y-2">
      <h3 id={id} className="text-sm font-medium">{title}</h3>
      <ul className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
        {[...rows].sort(problemsFirst).map((r) => {
          const nvr = recorderText(r.recorders)
          const body = (
            <>
              <span className="flex min-w-0 items-center gap-2 text-sm font-medium">
                <StateDot state={nodeState(r.counts)} />
                <span className="break-words"><span translate="no" className="font-mono">{r.code}</span> · {r.name}</span>
              </span>
              {r.counts.total > 0 && <span className="block text-xs text-muted-foreground">{countsText(r.counts)}</span>}
              {nvr && <span className={`block text-xs ${r.recorders && r.recorders.down > 0 ? 'font-medium text-[var(--destructive-strong)]' : 'text-muted-foreground'}`}>{nvr}</span>}
            </>
          )
          return (
            <li key={r.id}>
              {liveIds.has(r.id) ? (
                <Link href={`/live?${level}=${encodeURIComponent(r.id)}`} className="flex flex-col gap-1 rounded-xl border bg-card p-3 hover:bg-muted focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--ring)]">{body}</Link>
              ) : (
                <div className="flex flex-col gap-1 rounded-xl border bg-card p-3">{body}</div>
              )}
            </li>
          )
        })}
      </ul>
    </section>
  )
}
