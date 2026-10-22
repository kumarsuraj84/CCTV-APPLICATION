'use client'

import { useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import { Button } from '@/components/ui/button'
import { archiveNodeAction, restoreNodeAction, type AdminActionState } from '@/lib/actions/admin/locations'
import type { ArchiveKind } from '@/lib/inventory/archive'
import { Outcome } from './fields'

const EFFECT: Record<ArchiveKind, string> = {
  location: 'Its cameras, NVRs and assets are switched off and archived with it. Nobody can see them; their history, grants and groups are kept.',
  recorder: 'Nothing will contact this NVR. Move or archive its cameras first.',
  camera: 'The camera is switched off and unlinked from its NVR channel; its history, grants and groups are kept.',
  asset: 'The asset is switched off and its addresses are freed; its history is kept.',
  cluster: 'Only possible when it has no locations left. Grants at this cluster stop giving access.',
  region: 'Only possible when it has no clusters left. Grants at this region stop giving access.',
}

/** Archive (never delete) with a confirmation in the page that names the record and says what happens; or restore. */
export function ArchiveButton({ kind, id, archived, name }: { kind: ArchiveKind; id: string; archived: boolean; name: string }) {
  const router = useRouter()
  const [armed, setArmed] = useState(false)
  const [state, setState] = useState<AdminActionState | null>(null)
  const [busy, start] = useTransition()
  const run = (fn: typeof archiveNodeAction) =>
    start(async () => {
      const res = await fn(kind, id)
      setState(res)
      setArmed(false)
      if (res.ok) router.refresh()
    })
  if (archived) {
    return (
      <div className="space-y-2">
        <Button type="button" variant="outline" disabled={busy} onClick={() => run(restoreNodeAction)} aria-label={`Restore ${name}`}>{busy ? 'Restoring…' : 'Restore'}</Button>
        <Outcome state={state} />
      </div>
    )
  }
  return (
    <div className="space-y-2">
      {!armed ? (
        <Button type="button" variant="outline" onClick={() => setArmed(true)} aria-label={`Archive ${name}`}>Archive…</Button>
      ) : (
        <div role="group" aria-label={`Archive ${name}?`} className="space-y-2 rounded-md border border-destructive/40 bg-destructive-soft/30 p-3 text-sm">
          <p><span className="font-medium">Archive {name}?</span> {EFFECT[kind]}</p>
          <div className="flex flex-wrap gap-2">
            <Button type="button" variant="destructive" disabled={busy} onClick={() => run(archiveNodeAction)}>{busy ? 'Archiving…' : 'Yes, archive'}</Button>
            <Button type="button" variant="ghost" onClick={() => setArmed(false)}>Cancel</Button>
          </div>
        </div>
      )}
      <Outcome state={state} />
    </div>
  )
}
