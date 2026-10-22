'use client'

import { useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import { Button } from '@/components/ui/button'
import { dismissFindingAction, linkFindingAction, mergeCamerasAction, type AdminActionState } from '@/lib/actions/admin/locations'
import type { Finding } from '@/lib/inventory/findings'
import { formatDateTime } from '@/lib/time'
import { Outcome, SelectField, TextField } from './fields'

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
      return `The restored camera “${f.cameraName}” (last on channel ${f.channel}) could not be matched to anything the NVR lists.`
  }
}

/**
 * The reconciliation list (P2-5c-1 brief item 3): what camera discovery could not place, with the action that fits each item. Nothing
 * here is decided automatically: a camera never gets a second identity without a person choosing so.
 */
export function FindingsList({ findings, mergeCandidates }: { findings: Finding[]; mergeCandidates: Record<string, { id: string; label: string }[]> }) {
  if (findings.length === 0) return <p className="text-sm text-muted-foreground">Nothing to reconcile. Discovery placed every camera it found.</p>
  return <ul className="space-y-3">{findings.map((f) => <FindingRow key={f.id} f={f} candidates={mergeCandidates[f.cameraId] ?? []} />)}</ul>
}

function FindingRow({ f, candidates }: { f: Finding; candidates: { id: string; label: string }[] }) {
  const router = useRouter()
  const [note, setNote] = useState('')
  const [dup, setDup] = useState('')
  const [state, setState] = useState<AdminActionState | null>(null)
  const [busy, start] = useTransition()
  const run = (fn: () => Promise<AdminActionState>) => start(async () => {
    const res = await fn()
    setState(res)
    if (res.ok) router.refresh()
  })
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
      <div className="flex flex-wrap items-end gap-2">
        {(f.kind === 'possible_move' || f.kind === 'unplaced') && (
          <Button type="button" disabled={busy} onClick={() => run(() => linkFindingAction(f.id))}>
            {f.kind === 'possible_move' ? `Yes, it is “${f.cameraName}”: link it to channel ${f.channel}` : `Link it to channel ${f.channel} again`}
          </Button>
        )}
        {f.kind === 'channel_taken' && f.otherCameraId && (
          <Button type="button" variant="outline" disabled={busy} onClick={() => run(() => mergeCamerasAction({ keepId: f.cameraId, duplicateId: f.otherCameraId! }))}>
            Keep the restored camera (merge the other one into it)
          </Button>
        )}
      </div>
      {f.kind === 'missing' && candidates.length > 0 && (
        <div className="grid gap-2 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-end">
          <SelectField id={`${p}-dup`} name="duplicate" label="The new camera it became" value={dup} onChange={(e) => setDup(e.target.value)}>
            <option value="">Choose a camera</option>
            {candidates.map((c) => <option key={c.id} value={c.id}>{c.label}</option>)}
          </SelectField>
          <Button type="button" variant="outline" className="h-10" disabled={busy || !dup} onClick={() => run(() => mergeCamerasAction({ keepId: f.cameraId, duplicateId: dup }))}>Merge into “{f.cameraName}”</Button>
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
