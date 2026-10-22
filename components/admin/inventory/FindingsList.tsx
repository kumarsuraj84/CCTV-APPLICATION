'use client'

import { useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import { Button } from '@/components/ui/button'
import { dismissFindingAction, linkFindingAction, type AdminActionState } from '@/lib/actions/admin/locations'
import type { Finding } from '@/lib/inventory/findings'
import { formatDateTime } from '@/lib/time'
import { Outcome, TextField } from './fields'
import { CameraSearch, MergeButton } from './MergeConfirm'

const KIND: Record<Finding['kind'], string> = { possible_move: 'May have moved', missing: 'No longer listed', channel_taken: 'Channel in use', unplaced: 'Not placed' }

function sentence(f: Finding): string {
  switch (f.kind) {
    case 'possible_move':
      return `The NVR lists “${f.reportedName ?? ''}” on channel ${f.channel}, which may be the existing camera “${f.cameraName}”. Nothing was added.`
    case 'missing':
      return `“${f.cameraName}” was on channel ${f.channel}, which the NVR no longer lists. If the camera was moved to another NVR and found there as a new camera, merge that one into it.`
    case 'channel_taken':
      return `The restored camera “${f.cameraName}” was on channel ${f.channel}, which another camera uses now.`
    case 'unplaced':
      return `The restored camera “${f.cameraName}” (last on channel ${f.channel}, which the NVR no longer lists) could not be matched to anything the NVR lists. If the NVR shows it as a new camera now, merge that one into it; or link it to a channel in the mapping editor of its NVR.`
  }
}

/**
 * The reconciliation list (P2-5c-1 brief item 3): what camera discovery could not place, with the action that fits each item. Nothing
 * here is decided automatically, and nothing happens on one click (review I-5): linking and merging each ask first, naming the cameras.
 */
export function FindingsList({ findings, mergeCandidates }: { findings: Finding[]; mergeCandidates: Record<string, { id: string; label: string }[]> }) {
  if (findings.length === 0) return <p className="text-sm text-muted-foreground">Nothing to reconcile. Discovery placed every camera it found.</p>
  return <ul className="space-y-3">{findings.map((f) => <FindingRow key={f.id} f={f} candidates={mergeCandidates[f.cameraId] ?? []} />)}</ul>
}

function FindingRow({ f, candidates }: { f: Finding; candidates: { id: string; label: string }[] }) {
  const router = useRouter()
  const [note, setNote] = useState('')
  const [dup, setDup] = useState('')
  const [confirmLink, setConfirmLink] = useState(false)
  const [state, setState] = useState<AdminActionState | null>(null)
  const [busy, start] = useTransition()
  const done = (res: AdminActionState) => {
    setState(res)
    if (res.ok) router.refresh()
  }
  const run = (fn: () => Promise<AdminActionState>) => start(async () => done(await fn()))
  const p = `finding-${f.id}`
  return (
    <li className="space-y-2 rounded-md border bg-card p-3">
      <div className="flex flex-wrap items-center gap-2 text-sm">
        <span className="inline-flex items-center rounded-full border border-warning-strong/40 bg-warning-soft/60 px-2 py-0.5 text-xs font-medium text-warning-strong">{KIND[f.kind]}</span>
        <span className="font-mono">{f.locationCode}</span>
        <span>· {f.recorderName}</span>
        <span className="text-muted-foreground">· found {formatDateTime(f.foundAt)}</span>
      </div>
      <p className="text-sm">{sentence(f)}</p>
      {f.kind === 'possible_move' && (
        <div className="space-y-2">
          <Button type="button" disabled={busy} onClick={() => setConfirmLink(true)}>{`Link it to channel ${f.channel}…`}</Button>
          {confirmLink && (
            <div role="group" aria-label="Confirm the link" className="space-y-2 rounded-md border bg-muted/40 p-3 text-sm">
              <p>“{f.cameraName}” keeps its identity, access, groups and history and shows channel {f.channel} of {f.recorderName} from now on.</p>
              <div className="flex flex-wrap gap-2">
                <Button type="button" disabled={busy} onClick={() => { setConfirmLink(false); run(() => linkFindingAction(f.id)) }}>Yes, link it</Button>
                <Button type="button" variant="ghost" onClick={() => setConfirmLink(false)}>Cancel</Button>
              </div>
            </div>
          )}
        </div>
      )}
      {f.kind === 'channel_taken' && f.otherCameraId && (
        <MergeButton keepId={f.cameraId} duplicateId={f.otherCameraId} label="Keep the restored camera…" onDone={done} />
      )}
      {(f.kind === 'missing' || f.kind === 'unplaced') && (
        <div className="grid gap-2 lg:grid-cols-[minmax(0,1fr)_auto] lg:items-end">
          <CameraSearch id={`${p}-dup`} label="The new camera it became" value={dup} onChange={setDup} initial={candidates} />
          <MergeButton keepId={f.cameraId} duplicateId={dup} label={`Merge into “${f.cameraName}”…`} onDone={done} disabled={!dup} />
        </div>
      )}
      <div className="grid gap-2 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-end">
        <TextField id={`${p}-note`} name="note" label="Note (to take it off the list)" value={note} onChange={(e) => setNote(e.target.value)} maxLength={500} placeholder="For example: camera removed" />
        <Button type="button" variant="ghost" className="h-10" disabled={busy} onClick={() => run(() => dismissFindingAction(f.id, note))}>Take off the list</Button>
      </div>
      <Outcome state={state} />
    </li>
  )
}
