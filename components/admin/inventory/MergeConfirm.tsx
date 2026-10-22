'use client'

import { useReducer, useState, useTransition } from 'react'
import { Button } from '@/components/ui/button'
import { mergeCamerasAction, previewMergeAction, searchCamerasAction, type AdminActionState } from '@/lib/actions/admin/locations'
import { SelectField, TextField } from './fields'
import { initialMergeConfirm, mergeConfirmReducer, mergeRequest } from './merge-confirm-state'

/**
 * A merge never happens on one click (review I-5): "…" first asks the server what would happen — both cameras by name, the
 * duplicate's NVR and channel, how many people lose access — and only "Yes, merge" does it. Fix round 2 (A-N1): the question
 * belongs to the pair it names. Choosing another camera closes it, a late answer about another pair is dropped, and "Yes, merge"
 * sends the pair the question named with the server's confirmation (the server refuses any other pair).
 */
export function MergeButton({ keepId, duplicateId, label, onDone, disabled }: {
  keepId: string; duplicateId: string; label: string; onDone: (res: AdminActionState) => void; disabled?: boolean
}) {
  const [state, dispatch] = useReducer(mergeConfirmReducer, initialMergeConfirm)
  // Adjusting state to new props during render (React's documented pattern): the question can never outlive the choice it was about.
  if (state.chosen?.keepId !== keepId || state.chosen?.duplicateId !== duplicateId) dispatch({ type: 'choose', keepId, duplicateId })
  const [busy, start] = useTransition()
  const request = mergeRequest(state)
  const ask = () =>
    start(async () => {
      const p = await previewMergeAction({ keepId, duplicateId })
      if (p.ok) dispatch({ type: 'previewed', keepId: p.keepId, duplicateId: p.duplicateId, sentence: p.sentence, confirmation: p.confirmation })
      else onDone({ error: p.error })
    })
  const merge = () => {
    if (!request) return
    start(async () => {
      const res = await mergeCamerasAction(request)
      dispatch({ type: 'cancel' })
      onDone(res)
    })
  }
  return (
    <div className="space-y-2">
      <Button type="button" variant="outline" className="h-10" disabled={busy || disabled || !duplicateId} onClick={ask}>{label}</Button>
      {request && state.pending && (
        <div role="group" aria-label="Confirm the merge" className="space-y-2 rounded-md border border-destructive/40 bg-destructive-soft/30 p-3 text-sm">
          <p>{state.pending.sentence}</p>
          <div className="flex flex-wrap gap-2">
            <Button type="button" variant="destructive" disabled={busy} onClick={merge}>Yes, merge</Button>
            <Button type="button" variant="ghost" onClick={() => dispatch({ type: 'cancel' })}>Cancel</Button>
          </div>
        </div>
      )}
    </div>
  )
}

/** A camera of the whole organisation by name (review M-2: the duplicate may be at another location). */
export function CameraSearch({ id, label, value, onChange, initial }: {
  id: string; label: string; value: string; onChange: (id: string) => void; initial: { id: string; label: string }[]
}) {
  const [q, setQ] = useState('')
  const [found, setFound] = useState<{ id: string; label: string }[] | null>(null)
  const [note, setNote] = useState<string | null>(null)
  const [busy, start] = useTransition()
  const options = found ?? initial
  return (
    <div className="space-y-2">
      <div className="grid gap-2 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-end">
        <TextField id={`${id}-q`} name="q" label="Look for a camera by name (any location)" value={q} onChange={(e) => setQ(e.target.value)} maxLength={100} placeholder="For example Cash office" />
        <Button type="button" variant="outline" className="h-10" disabled={busy || q.trim().length < 2} onClick={() => start(async () => {
          const r = await searchCamerasAction(q)
          if (r.ok) { setFound(r.cameras); setNote(r.cameras.length === 0 ? 'No camera has that in its name.' : null) } else setNote(r.error)
        })}>Find</Button>
      </div>
      {note && <p role="status" className="text-sm text-muted-foreground">{note}</p>}
      <SelectField id={`${id}-pick`} name="camera" label={label} value={value} onChange={(e) => onChange(e.target.value)}>
        <option value="">Choose a camera</option>
        {options.map((c) => <option key={c.id} value={c.id}>{c.label}</option>)}
      </SelectField>
    </div>
  )
}
