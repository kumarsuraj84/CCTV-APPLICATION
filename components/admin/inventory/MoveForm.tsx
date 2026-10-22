'use client'

import { useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import { Button } from '@/components/ui/button'
import { moveNodeAction, previewMoveAction, type AdminActionState, type PreviewMoveState } from '@/lib/actions/admin/locations'
import { MSG_OPEN_VIDEO } from '@/lib/inventory/forms'
import { Outcome, SelectField } from './fields'

const RIGHT: Record<string, string> = { 'cctv.live': 'live video', 'cctv.playback': 'recordings', 'cctv.export': 'export' }

/**
 * Moves a location to another cluster, or a cluster to another region (ruling C-1), in two steps: "Check the effect on access" shows
 * who would gain or lose cameras (the database's preview), and only then "Move" saves exactly that move. The change takes effect at
 * once for everybody with a cluster or region grant there. Video already open is NOT cut off yet (review I-1): the session registry
 * (P2-4) will re-check open sessions; when it lands, change MSG_OPEN_VIDEO (lib/inventory/forms.ts) and its unit test.
 */
export function MoveForm({ kind, id, current, options }: { kind: 'location' | 'cluster'; id: string; current: string | null; options: { id: string; label: string }[] }) {
  const router = useRouter()
  const [to, setTo] = useState<string>(current ?? '')
  const [preview, setPreview] = useState<{ to: string; state: PreviewMoveState } | null>(null)
  const [state, setState] = useState<AdminActionState | null>(null)
  const [busy, start] = useTransition()
  const fieldId = `move-${kind}-${id}`
  const none = kind === 'location' ? 'No cluster' : 'No region'
  const checked = preview && preview.to === to && preview.state.ok ? preview.state : null
  const check = () =>
    start(async () => {
      setState(null)
      setPreview({ to, state: await previewMoveAction({ kind, id, to: to || null }) })
    })
  const move = () =>
    start(async () => {
      const res = await moveNodeAction({ kind, id, to: to || null })
      setState(res)
      if (res.ok) {
        setPreview(null)
        router.refresh()
      }
    })
  return (
    <div className="space-y-3">
      <div className="grid gap-3 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-end">
        <SelectField id={fieldId} name="to" label={kind === 'location' ? 'Cluster' : 'Region'} value={to} onChange={(e) => { setTo(e.target.value); setPreview(null) }}>
          <option value="">{none}</option>
          {options.map((o) => <option key={o.id} value={o.id}>{o.label}</option>)}
        </SelectField>
        <Button type="button" variant="outline" className="h-10" disabled={busy || to === (current ?? '')} onClick={check}>{busy && !checked ? 'Checking…' : 'Check the effect on access'}</Button>
      </div>
      <p className="text-xs text-muted-foreground">
        Access follows the new place at once: people with a {kind === 'location' ? 'cluster or region' : 'region'} grant there gain these cameras, people with one at the old place lose them. {MSG_OPEN_VIDEO}
      </p>
      {preview && preview.to === to && !preview.state.ok && <Outcome state={{ error: preview.state.error }} />}
      {checked && (
        <div role="status" className="space-y-2 rounded-md border bg-muted/40 p-3 text-sm">
          <p className="font-medium">
            {checked.locations} {checked.locations === 1 ? 'location' : 'locations'} move. {checked.affected === 0 ? 'Nobody’s access changes through a cluster or region grant.' : `${checked.affected} ${checked.affected === 1 ? 'person is' : 'people are'} affected:`}
          </p>
          {checked.people.length > 0 && (
            <ul className="list-disc space-y-0.5 pl-5">
              {checked.people.map((p, i) => (
                <li key={i}>{p.name}: {RIGHT[p.capability] ?? p.capability}, {p.before} → {p.after} {p.after === 1 ? 'camera' : 'cameras'}{p.after > p.before ? ' (gains)' : p.after < p.before ? ' (loses)' : ''}</li>
              ))}
            </ul>
          )}
          <Button type="button" disabled={busy} onClick={move}>{busy ? 'Moving…' : 'Move'}</Button>
        </div>
      )}
      <Outcome state={state} />
    </div>
  )
}
