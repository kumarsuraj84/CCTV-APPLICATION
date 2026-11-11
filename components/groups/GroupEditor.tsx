'use client'

import { useState, useTransition } from 'react'
import { toast } from 'sonner'
import { addByKeywordAction, addCamerasAction, removeCameraAction, type GroupActionState } from '@/lib/actions/groups'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Select } from '@/components/ui/select'
import type { GroupCamera, StoreCameraChoice } from '@/lib/queries/groups'
import { locationTitle } from '@/lib/inventory/forms' // final fix Y (C M-16)

export type GroupEditorProps = {
  groupId: string
  cameras: GroupCamera[]
  /** Operators and administrators change the group; everybody else only looks. */
  canManage: boolean
  /** Locations the person can see, for the "Add cameras" area. */
  stores: { id: string; code: string; name: string }[]
  selectedStoreId: string | null
  /** The cameras of the chosen location, or null when no location is chosen (or it cannot be used). */
  choices: StoreCameraChoice[] | null
  /** P2-2 fix M-1: cameras the person may take out (they may watch them live). Without it, every camera shows Remove. */
  removableIds?: string[]
}

function tell(res: GroupActionState, fallbackOk: string) {
  if (res.error) toast.error(res.error)
  else toast.success(res.message ?? fallbackOk)
}

export function GroupEditor({ groupId, cameras, canManage, stores, selectedStoreId, choices, removableIds }: GroupEditorProps) {
  const removable = (id: string) => !removableIds || removableIds.includes(id.toLowerCase())
  const [pending, start] = useTransition()
  const [picked, setPicked] = useState<Set<string>>(new Set())
  const [word, setWord] = useState('')

  const toggle = (id: string) =>
    setPicked((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })

  const addPicked = () =>
    start(async () => {
      const res = await addCamerasAction(groupId, [...picked])
      tell(res, 'Cameras added.')
      if (res.ok) setPicked(new Set())
    })

  const addByWord = () =>
    start(async () => {
      const res = await addByKeywordAction(groupId, word)
      tell(res, 'Cameras added.')
      if (res.ok) setWord('')
    })

  const remove = (cameraId: string) =>
    start(async () => {
      tell(await removeCameraAction(groupId, cameraId), 'Camera removed.')
    })

  const free = (choices ?? []).filter((c) => !c.in_group)

  return (
    <div className="space-y-6">
      <section aria-labelledby="group-cameras-title">
        <h2 id="group-cameras-title" className="mb-2 font-medium">Cameras ({cameras.length})</h2>
        {cameras.length === 0 ? (
          <p className="rounded-xl border bg-card p-4 text-sm text-muted-foreground">
            {canManage ? 'There are no cameras in this group yet. Use "Add cameras" below.' : 'There are no cameras in this group that you can see.'}
          </p>
        ) : (
          <ul className="divide-y rounded-xl border bg-card text-sm">
            {cameras.map((c) => (
              <li key={c.id} className="flex items-center justify-between gap-3 px-3 py-2">
                <span className="min-w-0 break-words">
                  <span className="font-mono">{c.store_code}</span> · channel {c.channel} · {c.name}
                  {c.from_rule && <span className="text-muted-foreground"> (added by a rule)</span>}
                </span>
                {canManage && removable(c.id) && !c.from_rule && (
                  <Button size="sm" variant="outline" disabled={pending} aria-label={`Remove ${c.name} (${c.store_code}, channel ${c.channel}) from the group`} onClick={() => remove(c.id)}>
                    Remove
                  </Button>
                )}
              </li>
            ))}
          </ul>
        )}
      </section>

      {canManage && (
        <section className="space-y-5 rounded-xl border bg-card p-4" aria-labelledby="add-cameras-title">
          <h2 id="add-cameras-title" className="font-medium">Add cameras</h2>

          <div className="space-y-3">
            <form method="get" className="flex flex-col gap-2 sm:flex-row sm:items-end">
              <div className="min-w-0 flex-1 space-y-1.5 sm:max-w-sm">
                <Label htmlFor="location-pick">Location</Label>
                <Select id="location-pick" name="location" defaultValue={selectedStoreId ?? ''}>
                  <option value="">Choose a location</option>
                  {stores.map((s) => (
                    <option key={s.id} value={s.id}>{locationTitle(s.code, s.name)}</option>
                  ))}
                </Select>
              </div>
              <Button type="submit" variant="outline">Show cameras</Button>
            </form>

            {selectedStoreId && choices === null && <p className="text-sm text-muted-foreground">That location is not available. Choose another one.</p>}
            {choices !== null && choices.length === 0 && <p className="text-sm text-muted-foreground">This location has no cameras to add.</p>}
            {choices !== null && choices.length > 0 && (
              <fieldset className="space-y-2">
                <legend className="text-sm font-medium">Cameras in this location</legend>
                <ul className="divide-y rounded-lg border text-sm">
                  {choices.map((c) => (
                    <li key={c.id}>
                      <label className="flex min-h-10 cursor-pointer items-center gap-3 px-3 py-2 has-[:disabled]:cursor-default has-[:disabled]:text-muted-foreground">
                        <input
                          type="checkbox"
                          className="size-4 shrink-0"
                          checked={c.in_group || picked.has(c.id)}
                          disabled={c.in_group || pending}
                          onChange={() => toggle(c.id)}
                        />
                        <span className="min-w-0 break-words">channel {c.channel} · {c.name}{c.in_group ? ' (already in the group)' : ''}</span>
                      </label>
                    </li>
                  ))}
                </ul>
                <div className="flex flex-wrap items-center gap-2">
                  <Button disabled={pending || picked.size === 0} onClick={addPicked}>
                    {pending ? 'Adding…' : picked.size === 0 ? 'Add selected cameras' : `Add ${picked.size} selected ${picked.size === 1 ? 'camera' : 'cameras'}`}
                  </Button>
                  {free.length > 0 && (
                    <Button variant="ghost" disabled={pending} onClick={() => setPicked(new Set(free.map((c) => c.id)))}>Select all not yet added</Button>
                  )}
                  {picked.size > 0 && <Button variant="ghost" disabled={pending} onClick={() => setPicked(new Set())}>Clear</Button>}
                </div>
                {free.length === 0 && <p className="text-sm text-muted-foreground">All the cameras of this location are already in the group.</p>}
              </fieldset>
            )}
          </div>

          <form
            className="space-y-1.5 border-t pt-4"
            onSubmit={(e) => {
              e.preventDefault()
              addByWord()
            }}
          >
            <Label htmlFor="word">Add by name</Label>
            <p id="word-hint" className="text-sm text-muted-foreground">Adds every camera you can see, in any location, whose name contains this word (up to 500 at a time). Capitals do not matter.</p>
            <div className="flex flex-col gap-2 sm:flex-row">
              <Input id="word" value={word} maxLength={100} onChange={(e) => setWord(e.target.value)} autoComplete="off" aria-describedby="word-hint" placeholder="For example: door" className="sm:max-w-sm" />
              <Button type="submit" variant="outline" disabled={pending || word.trim() === ''}>Add matching cameras</Button>
            </div>
          </form>
        </section>
      )}
    </div>
  )
}
