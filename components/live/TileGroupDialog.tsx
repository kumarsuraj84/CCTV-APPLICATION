'use client'

import { useRouter } from 'next/navigation'
import { useEffect, useRef, useState, useTransition } from 'react'
import { X } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { addCamerasAction, createGroupAction } from '@/lib/actions/groups'

// P4-L1 brief item 3 (LG-5): add the camera of a wall tile to a saved group, or to a new group, from the wall itself. Only offered to
// people who may change camera groups (the operator or administrator role AND live view); the actions check that again and check live
// view of the camera in the database (lib/groups/service.ts). Groups are a viewing convenience and never widen access.

export type EditableGroup = { id: string; name: string }

export function TileGroupDialog({ camera, groups, onClose }: { camera: { id: string; label: string }; groups: EditableGroup[]; onClose: () => void }) {
  const router = useRouter()
  const [pending, start] = useTransition()
  const [name, setName] = useState('')
  const box = useRef<HTMLDivElement>(null)

  useEffect(() => {
    box.current?.focus()
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [onClose])

  const done = (res: { ok?: boolean; error?: string; message?: string }, okText: string) => {
    if (res.error) toast.error(res.error)
    else {
      toast.success(res.message ?? okText)
      router.refresh()
      onClose()
    }
  }
  const addTo = (g: EditableGroup) =>
    start(async () => done(await addCamerasAction(g.id, [camera.id]), `Added to ${g.name}.`))
  const createAndAdd = () =>
    start(async () => {
      const fd = new FormData()
      fd.set('name', name)
      const made = await createGroupAction({}, fd)
      if (made.error || !made.groupId) {
        toast.error(made.error ?? 'Could not create the group.')
        return
      }
      done(await addCamerasAction(made.groupId, [camera.id]), 'Group created with this camera.')
    })

  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/50 p-4" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div ref={box} tabIndex={-1} role="dialog" aria-modal="true" aria-labelledby="tile-group-title" className="w-full max-w-sm space-y-3 rounded-xl border bg-card p-4 text-foreground shadow-lg outline-none">
        <div className="flex items-start justify-between gap-2">
          <h2 id="tile-group-title" className="text-sm font-semibold">Add {camera.label} to a group</h2>
          <Button type="button" size="sm" variant="ghost" aria-label="Close" onClick={onClose}><X aria-hidden="true" /></Button>
        </div>
        {groups.length > 0 ? (
          <ul className="max-h-60 space-y-1 overflow-y-auto">
            {groups.map((g) => (
              <li key={g.id}>
                <Button type="button" variant="outline" className="w-full justify-start" disabled={pending} onClick={() => addTo(g)}>
                  <span className="truncate">{g.name}</span>
                </Button>
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-sm text-muted-foreground">You have no camera groups yet.</p>
        )}
        <form
          className="space-y-2 border-t pt-3"
          onSubmit={(e) => {
            e.preventDefault()
            createAndAdd()
          }}
        >
          <Label htmlFor="tile-new-group">Or make a new group</Label>
          <div className="flex gap-2">
            <Input id="tile-new-group" value={name} onChange={(e) => setName(e.target.value)} placeholder="Group name" maxLength={100} />
            <Button type="submit" disabled={pending || name.trim() === ''}>Create</Button>
          </div>
        </form>
      </div>
    </div>
  )
}
