'use client'

import { useEffect, useState, useTransition } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { CircleCheck, CircleX, MinusCircle, ScanSearch } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { FormAlert } from '@/components/ui/form-alert'
import { discoverAllStatusAction, startDiscoverAllAction, stopDiscoverAllAction } from '@/lib/actions/admin/discover-all'
import type { RunItem, RunView } from '@/lib/inventory/discover-all'
import { formatDateTime } from '@/lib/time'

// "Find cameras for all locations" (P2-5c-2 brief item 2): says what it will do before it starts, then shows the progress (polled every
// two seconds) and, at the end, one line per NVR. The search only reads from the NVRs; what cannot be placed goes to the
// reconciliation list.

const LINK = 'font-medium text-primary underline-offset-2 hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring'
const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`
const OUTCOME: Record<RunItem['outcome'], { word: string; Icon: typeof CircleCheck; tone: string }> = {
  done: { word: 'Done', Icon: CircleCheck, tone: 'text-success-strong' },
  failed: { word: 'Failed', Icon: CircleX, tone: 'text-destructive-strong' },
  skipped: { word: 'Skipped', Icon: MinusCircle, tone: 'text-muted-foreground' },
}

export type DiscoverCounts = { recorders: number; switchedOff: number; locationOff: number; concurrency: number }

export function DiscoverAll({ initial, counts }: { initial: RunView | null; counts: DiscoverCounts }) {
  const router = useRouter()
  const [run, setRun] = useState<RunView | null>(initial)
  const [error, setError] = useState<string | null>(null)
  const [pending, start] = useTransition()
  /** Review B-M10: polling stops for good after an answer it cannot use (for example the server restarted and forgot the run). */
  const [lost, setLost] = useState(false)
  const running = run !== null && run.finishedAt === null && !lost
  useEffect(() => {
    if (!running || !run) return
    const id = run.id
    const t = setInterval(async () => {
      const s = await discoverAllStatusAction(id)
      if (s.ok) {
        setRun(s.run)
        if (s.run.finishedAt) router.refresh()
      } else {
        setError(s.error)
        setLost(true)
        clearInterval(t)
      }
    }, 2000)
    return () => clearInterval(t)
  }, [running, run, router])
  const onStop = () => start(async () => {
    if (!run) return
    const r = await stopDiscoverAllAction(run.id)
    if (!r.ok) setError(r.error)
    else setRun({ ...run, stopped: true })
  })
  const onStart = () => start(async () => {
    setError(null)
    setLost(false)
    const r = await startDiscoverAllAction()
    if (!r.ok) {
      setError(r.error)
      return
    }
    setRun({ id: r.runId, startedAt: new Date().toISOString(), finishedAt: null, total: r.total, done: 0, concurrency: counts.concurrency, items: [], summary: { asked: 0, done: 0, failed: 0, skipped: 0, cameras: 0, created: 0, mapped: 0, moved: 0, toReconcile: 0 }, error: null, stopped: false })
  })
  const skipped = counts.switchedOff + counts.locationOff
  return (
    <div className="space-y-4">
      <div className="space-y-2 text-sm">
        <p>
          This asks each of the {plural(counts.recorders, 'NVR', 'NVRs')} of your locations for its list of cameras, {counts.concurrency} at a time. It only reads
          from the NVRs: nothing on them is changed. Existing cameras keep their identity, access and history; new channels get a camera; anything that
          cannot be placed safely goes to the <Link href="/admin/reconciliation" className={LINK}>reconciliation list</Link> for a person to decide.
        </p>
        <p>
          {skipped === 0 ? 'No NVR is skipped.' : `${counts.switchedOff === 1 ? '1 NVR is' : `${counts.switchedOff} NVRs are`} switched off and ${plural(counts.locationOff, 'NVR is', 'NVRs are')} at a switched-off location: they are skipped without being contacted.`}{' '}
          An NVR that refused a login a short while ago is not asked again until the wait is over, and one that refused several is left alone for longer, to protect its account.
        </p>
      </div>
      <Button type="button" onClick={onStart} disabled={pending || running || counts.recorders === 0}>
        <ScanSearch aria-hidden="true" />
        {running ? 'Looking for cameras…' : 'Find cameras for all locations'}
      </Button>
      {counts.recorders === 0 && <p className="text-sm text-muted-foreground">There is no NVR yet. Add NVRs on the location pages or import them first.</p>}
      <div aria-live="polite" className="space-y-3 empty:hidden">
        {error && <FormAlert tone="error">{error}</FormAlert>}
        {run && running && (
          <div className="space-y-1.5">
            <label htmlFor="discover-progress" className="block text-sm font-medium">{`${run.done} of ${plural(run.total, 'NVR', 'NVRs')} done`}</label>
            <progress id="discover-progress" value={run.done} max={Math.max(1, run.total)} className="h-2 w-full accent-primary" />
            <p className="text-xs text-muted-foreground">Started {formatDateTime(run.startedAt)}. You may leave this page: the search goes on, and its results are saved NVR by NVR.</p>
            {run.stopped
              ? <p className="text-sm">Stopping: the NVRs being asked now finish; no other NVR is asked.</p>
              : <Button type="button" variant="outline" onClick={onStop} disabled={pending}>Stop the search</Button>}
          </div>
        )}
        {run && !running && <RunResults run={run} />}
      </div>
    </div>
  )
}

/** The outcome of a finished run: a summary, then one line per NVR (failed first). */
export function RunResults({ run }: { run: RunView }) {
  const order: Record<RunItem['outcome'], number> = { failed: 0, done: 1, skipped: 2 }
  const items = [...run.items].sort((a, b) => order[a.outcome] - order[b.outcome] || a.code.localeCompare(b.code) || a.nvrName.localeCompare(b.nvrName))
  const s = run.summary
  return (
    <section aria-labelledby="discover-results" className="space-y-3">
      <h3 id="discover-results" className="text-base font-semibold">Last search: {run.finishedAt ? formatDateTime(run.finishedAt) : 'still running'}</h3>
      {run.stopped && <p className="text-sm font-medium">This search was stopped: the NVRs not asked by then are listed as skipped.</p>}
      {run.error ? <FormAlert tone="error">{run.error}</FormAlert> : (
        <p className="text-sm">
          {plural(s.asked, 'NVR', 'NVRs')} asked: {s.done} answered, {s.failed} failed; {s.skipped} skipped. {plural(s.cameras, 'camera', 'cameras')} listed, {s.created} new,
          {' '}{s.mapped} linked again, {s.moved} moved to another channel. {s.toReconcile > 0
            ? <>{plural(s.toReconcile, 'camera needs', 'cameras need')} a look on the <Link href="/admin/reconciliation" className={LINK}>reconciliation list</Link>.</>
            : <>Nothing for the <Link href="/admin/reconciliation" className={LINK}>reconciliation list</Link>.</>}
        </p>
      )}
      {items.length > 0 && (
        <ul className="space-y-2 sm:hidden" aria-label="One line per NVR">
          {items.map((i) => {
            const o = OUTCOME[i.outcome]
            return (
              <li key={i.recorderId} className="space-y-0.5 rounded-md border bg-card p-3 text-sm">
                <div className="flex flex-wrap items-baseline justify-between gap-2">
                  <Link href={`/admin/locations/${i.locationId}/nvrs/${i.recorderId}`} className={LINK}><span className="font-mono">{i.code}</span> · {i.nvrName}</Link>
                  <span className={`inline-flex items-center gap-1 ${o.tone}`}><o.Icon aria-hidden="true" className="size-4" />{o.word}</span>
                </div>
                {i.outcome === 'done' ? <p>{`${plural(i.cameras, 'camera', 'cameras')} listed, ${i.created} new, ${i.toReconcile} to look at.`}</p> : <p>{i.message}</p>}
              </li>
            )
          })}
        </ul>
      )}
      {items.length > 0 && (
        <div className="hidden overflow-x-auto rounded-md border bg-card sm:block">
          <table className="w-full min-w-[720px] text-sm">
            <caption className="sr-only">One line per NVR</caption>
            <thead className="text-left text-xs text-muted-foreground">
              <tr>
                <th scope="col" className="px-3 py-2 font-medium">Location</th><th scope="col" className="px-3 py-2 font-medium">NVR</th>
                <th scope="col" className="px-3 py-2 font-medium">Outcome</th><th scope="col" className="px-3 py-2 text-right font-medium">Listed</th>
                <th scope="col" className="px-3 py-2 text-right font-medium">New</th><th scope="col" className="px-3 py-2 text-right font-medium">To look at</th>
                <th scope="col" className="px-3 py-2 font-medium">Why</th>
              </tr>
            </thead>
            <tbody>
              {items.map((i) => {
                const o = OUTCOME[i.outcome]
                return (
                  <tr key={i.recorderId} className="border-t">
                    <td className="px-3 py-1.5 font-mono"><Link href={`/admin/locations/${i.locationId}`} className={LINK}>{i.code}</Link></td>
                    <td className="px-3 py-1.5"><Link href={`/admin/locations/${i.locationId}/nvrs/${i.recorderId}`} className={LINK}>{i.nvrName}</Link></td>
                    <td className={`px-3 py-1.5 ${o.tone}`}><span className="inline-flex items-center gap-1"><o.Icon aria-hidden="true" className="size-4" />{o.word}</span></td>
                    <td className="px-3 py-1.5 text-right tabular-nums">{i.outcome === 'done' ? i.cameras : '—'}</td>
                    <td className="px-3 py-1.5 text-right tabular-nums">{i.outcome === 'done' ? i.created : '—'}</td>
                    <td className="px-3 py-1.5 text-right tabular-nums">{i.outcome === 'done' ? i.toReconcile : '—'}</td>
                    <td className="px-3 py-1.5">{i.message ?? '—'}</td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      )}
    </section>
  )
}
