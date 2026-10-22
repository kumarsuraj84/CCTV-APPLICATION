'use client'

import { useState, useTransition } from 'react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { addRuleAction, removeRuleAction } from '@/lib/actions/groups'
import { SelectField, TextField } from '@/components/admin/inventory/fields'

type Kind = 'region' | 'cluster' | 'location' | 'recorder' | 'name'
const KIND_LABEL: Record<Kind, string> = { region: 'Every camera of a region', cluster: 'Every camera of a cluster', location: 'Every camera of a location', recorder: 'Every camera of an NVR', name: 'Every camera whose name contains a word' }
const PLACE_LABEL: Record<Exclude<Kind, 'name'>, string> = { region: 'Region', cluster: 'Cluster', location: 'Location', recorder: 'NVR' }

/**
 * Dynamic rules of a camera group (P2-5c-1 brief item 6). A rule adds every camera of a place (optionally only those whose name
 * contains a word), now and later. Everybody still sees only the cameras they may see: a rule never gives anybody access.
 */
export function GroupRules({ groupId, rules, places }: {
  groupId: string
  rules: { id: string; kind: Kind; label: string; nameContains: string | null }[]
  places: Partial<Record<Exclude<Kind, 'name'>, { id: string; label: string }[]>>
}) {
  const kinds = (['cluster', 'location', 'region', 'recorder'] as const).filter((k) => (places[k] ?? []).length > 0)
  const [kind, setKind] = useState<Kind>(kinds[0] ?? 'name')
  const [ref, setRef] = useState('')
  const [word, setWord] = useState('')
  const [busy, start] = useTransition()
  const tell = (res: { ok?: boolean; error?: string; message?: string }) => (res.error ? toast.error(res.error) : toast.success(res.message ?? 'Done.'))
  const options = kind === 'name' ? [] : places[kind] ?? []
  return (
    <section aria-labelledby="group-rules-title" className="space-y-4 rounded-xl border bg-card p-4">
      <div>
        <h2 id="group-rules-title" className="font-medium">Rules (cameras added automatically)</h2>
        <p className="text-sm text-muted-foreground">Cameras added to the place later join the group by themselves. Each person still sees only the cameras they may see.</p>
      </div>
      {rules.length === 0 ? <p className="text-sm text-muted-foreground">No rules yet.</p> : (
        <ul className="divide-y rounded-lg border text-sm">
          {rules.map((r) => (
            <li key={r.id} className="flex flex-wrap items-center justify-between gap-2 px-3 py-2">
              <span>{r.label}{r.nameContains ? `, names containing “${r.nameContains}”` : ''}</span>
              <Button type="button" size="sm" variant="outline" disabled={busy} aria-label={`Remove the rule ${r.label}`} onClick={() => start(async () => { tell(await removeRuleAction(groupId, r.id)) })}>Remove</Button>
            </li>
          ))}
        </ul>
      )}
      <form className="grid gap-3 sm:grid-cols-2 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_minmax(0,1fr)_auto] lg:items-end" onSubmit={(e) => {
        e.preventDefault()
        start(async () => {
          const res = await addRuleAction(groupId, { kind, refId: kind === 'name' ? null : ref, nameContains: word || null })
          tell(res)
          if (res.ok) { setRef(''); setWord('') }
        })
      }}>
        <SelectField id={`rule-kind-${groupId}`} name="kind" label="Include" value={kind} onChange={(e) => { setKind(e.target.value as Kind); setRef('') }}>
          {[...kinds, 'name' as const].map((k) => <option key={k} value={k}>{KIND_LABEL[k]}</option>)}
        </SelectField>
        {kind !== 'name' ? (
          <SelectField id={`rule-place-${groupId}`} name="place" label={PLACE_LABEL[kind]} value={ref} onChange={(e) => setRef(e.target.value)}>
            <option value="">Choose…</option>
            {options.map((o) => <option key={o.id} value={o.id}>{o.label}</option>)}
          </SelectField>
        ) : <div className="hidden lg:block" />}
        <TextField id={`rule-word-${groupId}`} name="word" label={kind === 'name' ? 'Name contains' : 'Only names containing (optional)'} value={word} onChange={(e) => setWord(e.target.value)} maxLength={100} placeholder="For example till" />
        <Button type="submit" className="h-10" disabled={busy || (kind === 'name' ? !word.trim() : !ref)}>Add rule</Button>
      </form>
    </section>
  )
}
