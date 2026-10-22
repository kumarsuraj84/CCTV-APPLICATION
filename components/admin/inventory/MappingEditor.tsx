'use client'

import { useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import { Button } from '@/components/ui/button'
import { remapCameraAction, type AdminActionState } from '@/lib/actions/admin/locations'
import { formatDateTime } from '@/lib/time'
import { Outcome, SelectField, TextField } from './fields'
import { MergeButton } from './MergeConfirm'

export type MappingCamera = {
  id: string; name: string; channel: number | null; recorderId: string | null
  history: { recorderName: string; channel: number; validFrom: string; validTo: string | null }[]
}

/**
 * The mapping editor (P2-5c-1 brief item 3): for each camera, which NVR channel shows it, its mapping history, and two changes —
 * "Move" to another NVR or channel of the location (identity, access, groups and history kept; its old live streams are removed), and
 * "Merge a duplicate into this camera" for a camera that was physically moved and got a second identity on its new NVR.
 */
export function MappingEditor({ cameras, recorders, mergeCandidates }: { cameras: MappingCamera[]; recorders: { id: string; name: string }[]; mergeCandidates: { id: string; label: string }[] }) {
  if (cameras.length === 0) return <p className="text-sm text-muted-foreground">No cameras on this NVR yet. Use “Find cameras”.</p>
  return (
    <ul className="space-y-3">
      {cameras.map((c) => <CameraRow key={c.id} camera={c} recorders={recorders} candidates={mergeCandidates.filter((m) => m.id !== c.id)} />)}
    </ul>
  )
}

function CameraRow({ camera, recorders, candidates }: { camera: MappingCamera; recorders: { id: string; name: string }[]; candidates: { id: string; label: string }[] }) {
  const router = useRouter()
  const [recorder, setRecorder] = useState(camera.recorderId ?? recorders[0]?.id ?? '')
  const [channel, setChannel] = useState(camera.channel ? String(camera.channel) : '')
  const [duplicate, setDuplicate] = useState('')
  const [state, setState] = useState<AdminActionState | null>(null)
  const [busy, start] = useTransition()
  const p = `map-${camera.id}`
  const done = (res: AdminActionState) => {
    setState(res)
    if (res.ok) router.refresh()
  }
  const current = recorders.find((r) => r.id === camera.recorderId)
  return (
    <li className="space-y-3 rounded-md border p-3">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <p className="font-medium">{camera.name}</p>
        <p className="text-sm text-muted-foreground">{current && camera.channel ? `${current.name}, channel ${camera.channel}` : 'Not linked to an NVR channel'}</p>
      </div>
      <div className="grid gap-2 sm:grid-cols-[minmax(0,1fr)_8rem_auto] sm:items-end">
        <SelectField id={`${p}-nvr`} name="recorder" label="NVR" value={recorder} onChange={(e) => setRecorder(e.target.value)}>
          {recorders.map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}
        </SelectField>
        <TextField id={`${p}-ch`} name="channel" label="Channel" inputMode="numeric" value={channel} onChange={(e) => setChannel(e.target.value)} />
        <Button type="button" variant="outline" className="h-10" disabled={busy || (recorder === camera.recorderId && channel === String(camera.channel ?? ''))}
          onClick={() => start(async () => done(await remapCameraAction({ cameraId: camera.id, recorderId: recorder, channel })))}>
          {camera.recorderId ? 'Move camera' : 'Link camera'}
        </Button>
      </div>
      {candidates.length > 0 && (
        <div className="grid gap-2 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-start">
          <SelectField id={`${p}-dup`} name="duplicate" label="Merge a duplicate into this camera" value={duplicate} onChange={(e) => setDuplicate(e.target.value)}
            help="For a camera that was moved to another NVR and was found there again as a new camera.">
            <option value="">Choose the duplicate</option>
            {candidates.map((m) => <option key={m.id} value={m.id}>{m.label}</option>)}
          </SelectField>
          {/* Review I-5 / M-3: the confirmation names both cameras, the duplicate's NVR and channel, and who loses access. */}
          <div className="sm:pt-6"><MergeButton keepId={camera.id} duplicateId={duplicate} label="Merge…" onDone={done} disabled={!duplicate} /></div>
        </div>
      )}
      <details>
        <summary className="cursor-pointer text-sm underline-offset-2 hover:underline">Mapping history ({camera.history.length})</summary>
        <table className="mt-2 w-full text-sm">
          <caption className="sr-only">Mapping history of {camera.name}</caption>
          <thead className="text-left text-xs text-muted-foreground"><tr><th scope="col" className="py-1 pr-2 font-medium">NVR</th><th scope="col" className="py-1 pr-2 font-medium">Channel</th><th scope="col" className="py-1 pr-2 font-medium">From</th><th scope="col" className="py-1 font-medium">Until</th></tr></thead>
          <tbody>
            {camera.history.map((h, i) => (
              <tr key={i} className="border-t"><td className="py-1 pr-2">{h.recorderName}</td><td className="py-1 pr-2 tabular-nums">{h.channel}</td><td className="py-1 pr-2">{formatDateTime(h.validFrom)}</td><td className="py-1">{h.validTo ? formatDateTime(h.validTo) : 'now'}</td></tr>
            ))}
          </tbody>
        </table>
      </details>
      <Outcome state={state} />
    </li>
  )
}
