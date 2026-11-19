'use client'

import { useState, useTransition } from 'react'
import { toast } from 'sonner'
import { addCamerasAction, previewByKeywordAction, removeCamerasAction } from '@/lib/actions/groups'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'

// "Add by name" in a camera group (final clean-up, review C M-20): first a preview of the cameras the word finds (nothing changes),
// then "Add these N cameras" adds exactly those (each checked again), and the addition can be undone at once (only the cameras it put
// in the group are taken out again).

const SHOWN = 10
const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`

export type Preview = { word: string; cameras: { id: string; name: string }[]; truncated: boolean }

/** What the word found, before anything changes. */
export function PreviewPanel({ preview, pending, onAdd, onCancel }: { preview: Preview; pending: boolean; onAdd: () => void; onCancel: () => void }) {
  const n = preview.cameras.length
  const more = n - SHOWN
  return (
    <div role="region" aria-label="Cameras that would be added" className="space-y-2 rounded-lg border p-3 text-sm">
      {n === 0 ? (
        <p>No new cameras have “{preview.word}” in their name. They may already be in the group, or you may not be able to see them.</p>
      ) : (
        <>
          <p className="font-medium">{plural(n, 'camera', 'cameras')} with “{preview.word}” in the name would be added:</p>
          <ul className="list-disc space-y-0.5 pl-5">
            {preview.cameras.slice(0, SHOWN).map((c) => <li key={c.id} className="break-words">{c.name}</li>)}
          </ul>
          {more > 0 && <p className="text-muted-foreground">and {plural(more, 'more camera', 'more cameras')}.</p>}
        </>
      )}
      {preview.truncated && <p className="text-muted-foreground">More than 500 cameras matched; only the first 500 (in name order) were looked at. Use a longer word to narrow it down.</p>}
      <div className="flex flex-wrap gap-2">
        {n > 0 && <Button disabled={pending} onClick={onAdd}>{pending ? 'Adding…' : `Add ${n === 1 ? 'this camera' : `these ${n} cameras`}`}</Button>}
        <Button variant="ghost" disabled={pending} onClick={onCancel}>{n > 0 ? 'Cancel' : 'Close'}</Button>
      </div>
    </div>
  )
}

/** After an addition: what changed, and the way back. */
export function UndoNotice({ count, pending, onUndo }: { count: number; pending: boolean; onUndo: () => void }) {
  return (
    <p role="status" className="flex flex-wrap items-center gap-2 rounded-lg border bg-muted/40 px-3 py-2 text-sm">
      <span>Added {plural(count, 'camera', 'cameras')} to the group.</span>
      <Button size="sm" variant="outline" disabled={pending} onClick={onUndo}>Undo</Button>
    </p>
  )
}

export function AddByName({ groupId }: { groupId: string }) {
  const [pending, start] = useTransition()
  const [word, setWord] = useState('')
  const [preview, setPreview] = useState<Preview | null>(null)
  const [added, setAdded] = useState<string[]>([])

  const look = () =>
    start(async () => {
      const w = word.trim()
      const res = await previewByKeywordAction(groupId, w)
      if (res.error || !res.preview) return void toast.error(res.error ?? 'Could not look up the cameras.')
      setAdded([])
      setPreview({ word: w, cameras: res.preview.cameras, truncated: res.preview.truncated })
    })

  const add = () =>
    start(async () => {
      if (!preview) return
      const res = await addCamerasAction(groupId, preview.cameras.map((c) => c.id))
      if (res.error) return void toast.error(res.error)
      setPreview(null)
      setWord('')
      setAdded(res.cameraIds ?? [])
      if ((res.cameraIds ?? []).length === 0) toast.success(res.message ?? 'Nothing new to add.')
    })

  const undo = () =>
    start(async () => {
      const res = await removeCamerasAction(groupId, added)
      if (res.error) return void toast.error(res.error)
      setAdded([])
      toast.success(res.message ?? 'Undone.')
    })

  return (
    <div className="space-y-3 border-t pt-4">
      <form
        className="space-y-1.5"
        onSubmit={(e) => {
          e.preventDefault()
          look()
        }}
      >
        <Label htmlFor="word">Add by name</Label>
        <p id="word-hint" className="text-sm text-muted-foreground">Finds every camera you can watch live, in any location, whose name contains this word (capitals do not matter; up to 500). You see the list before anything is added.</p>
        <div className="flex flex-col gap-2 sm:flex-row">
          <Input id="word" value={word} maxLength={100} onChange={(e) => setWord(e.target.value)} autoComplete="off" aria-describedby="word-hint" placeholder="For example: door" className="sm:max-w-sm" />
          <Button type="submit" variant="outline" disabled={pending || word.trim() === ''}>Show matching cameras</Button>
        </div>
      </form>
      {preview && <PreviewPanel preview={preview} pending={pending} onAdd={add} onCancel={() => setPreview(null)} />}
      {added.length > 0 && <UndoNotice count={added.length} pending={pending} onUndo={undo} />}
    </div>
  )
}
