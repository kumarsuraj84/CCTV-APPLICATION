'use client'

import { useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import { Button } from '@/components/ui/button'
import { addDependencyAction, addEndpointAction, removeDependencyAction, retireEndpointAction } from '@/lib/actions/admin/assets'
import type { AdminActionState } from '@/lib/actions/admin/locations'
import { DEPENDENCY_KINDS, DEPENDENCY_LABELS, ENDPOINT_PURPOSE_LABELS, ENDPOINT_PURPOSES } from '@/lib/inventory/forms'
import { formatDateTime } from '@/lib/time'
import { Outcome, SelectField, TextField } from './fields'

function useRun() {
  const router = useRouter()
  const [state, setState] = useState<AdminActionState | null>(null)
  const [busy, start] = useTransition()
  const run = (fn: () => Promise<AdminActionState>, after?: () => void) => start(async () => {
    const res = await fn()
    setState(res)
    if (res.ok) {
      after?.()
      router.refresh()
    }
  })
  return { state, busy, run }
}

/** What this asset depends on (its parents) for network, power or recording; a loop is refused with a plain sentence. */
export function DependencyPicker({ assetId, dependencies, candidates }: {
  assetId: string; dependencies: { id: string; parentId: string; parentName: string; kind: string }[]; candidates: { id: string; label: string }[]
}) {
  const { state, busy, run } = useRun()
  const [parent, setParent] = useState('')
  const [kind, setKind] = useState<string>('network')
  const p = `dep-${assetId}`
  return (
    <div className="space-y-3">
      {dependencies.length === 0 ? <p className="text-sm text-muted-foreground">No dependencies recorded.</p> : (
        <ul className="divide-y rounded-md border text-sm">
          {dependencies.map((d) => (
            <li key={d.id} className="flex flex-wrap items-center justify-between gap-2 px-3 py-2">
              <span>Depends on <span className="font-medium">{d.parentName}</span> for {DEPENDENCY_LABELS[d.kind as keyof typeof DEPENDENCY_LABELS]?.toLowerCase() ?? d.kind}</span>
              <Button type="button" size="sm" variant="ghost" disabled={busy} aria-label={`Remove the dependency on ${d.parentName}`} onClick={() => run(() => removeDependencyAction(d.id))}>Remove</Button>
            </li>
          ))}
        </ul>
      )}
      <div className="grid gap-2 sm:grid-cols-[minmax(0,1fr)_10rem_auto] sm:items-end">
        <SelectField id={`${p}-parent`} name="parent" label="Depends on" value={parent} onChange={(e) => setParent(e.target.value)}>
          <option value="">Choose an asset</option>
          {candidates.map((c) => <option key={c.id} value={c.id}>{c.label}</option>)}
        </SelectField>
        <SelectField id={`${p}-kind`} name="kind" label="For" value={kind} onChange={(e) => setKind(e.target.value)}>
          {DEPENDENCY_KINDS.map((k) => <option key={k} value={k}>{DEPENDENCY_LABELS[k]}</option>)}
        </SelectField>
        <Button type="button" variant="outline" className="h-10" disabled={busy || !parent} onClick={() => run(() => addDependencyAction({ childId: assetId, parentId: parent, kind }), () => setParent(''))}>Add dependency</Button>
      </div>
      <Outcome state={state} />
    </div>
  )
}

/** The asset's addresses per address space. The management address follows the asset itself; extra ones (SNMP, other) are added here. */
export function EndpointsEditor({ assetId, endpoints, spaces }: {
  assetId: string; endpoints: { id: string; spaceName: string; host: string; port: number | null; purpose: string; retiredAt: string | null }[]; spaces: { id: string; name: string }[]
}) {
  const { state, busy, run } = useRun()
  const [space, setSpace] = useState(spaces[0]?.id ?? '')
  const [host, setHost] = useState('')
  const [port, setPort] = useState('')
  const [purpose, setPurpose] = useState<string>('snmp')
  const p = `ep-${assetId}`
  return (
    <div className="space-y-3">
      {/* relative: keeps the visually hidden column heading inside the scroll box (it otherwise widened the page on a phone). */}
      <div className="relative overflow-x-auto rounded-md border">
        <table className="w-full min-w-[520px] text-sm">
          <caption className="sr-only">Addresses of this asset</caption>
          <thead className="text-left text-xs text-muted-foreground"><tr><th scope="col" className="px-3 py-2 font-medium">Address space</th><th scope="col" className="px-3 py-2 font-medium">Address</th><th scope="col" className="px-3 py-2 font-medium">For</th><th scope="col" className="px-3 py-2 font-medium">State</th><th scope="col" className="px-3 py-2"><span className="sr-only">Actions</span></th></tr></thead>
          <tbody>
            {endpoints.map((e) => (
              <tr key={e.id} className="border-t">
                <td className="px-3 py-2">{e.spaceName}</td>
                <td className="px-3 py-2 font-mono">{e.host}{e.port ? `:${e.port}` : ''}</td>
                <td className="px-3 py-2">{ENDPOINT_PURPOSE_LABELS[e.purpose] ?? e.purpose}</td>
                <td className="px-3 py-2">{e.retiredAt ? `Retired ${formatDateTime(e.retiredAt)}` : 'In use'}</td>
                <td className="px-3 py-2 text-right">
                  {!e.retiredAt && e.purpose !== 'management' && e.purpose !== 'rtsp' && (
                    <Button type="button" size="sm" variant="ghost" disabled={busy} aria-label={`Retire ${e.host}`} onClick={() => run(() => retireEndpointAction(e.id))}>Retire</Button>
                  )}
                </td>
              </tr>
            ))}
            {endpoints.length === 0 && <tr><td colSpan={5} className="px-3 py-2 text-muted-foreground">No addresses.</td></tr>}
          </tbody>
        </table>
      </div>
      <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_7rem_9rem_auto] lg:items-end">
        <SelectField id={`${p}-space`} name="space" label="Address space" value={space} onChange={(e) => setSpace(e.target.value)}>
          {spaces.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
        </SelectField>
        <TextField id={`${p}-host`} name="host" label="Address" value={host} onChange={(e) => setHost(e.target.value)} placeholder="10.20.0.2" />
        <TextField id={`${p}-port`} name="port" label="Port" inputMode="numeric" value={port} onChange={(e) => setPort(e.target.value)} />
        <SelectField id={`${p}-purpose`} name="purpose" label="For" value={purpose} onChange={(e) => setPurpose(e.target.value)}>
          {ENDPOINT_PURPOSES.map((x) => <option key={x} value={x}>{ENDPOINT_PURPOSE_LABELS[x]}</option>)}
        </SelectField>
        <Button type="button" variant="outline" className="h-10" disabled={busy || !host.trim()} onClick={() => run(() => addEndpointAction(assetId, { spaceId: space, host, port, purpose }), () => { setHost(''); setPort('') })}>Add address</Button>
      </div>
      <Outcome state={state} />
    </div>
  )
}
