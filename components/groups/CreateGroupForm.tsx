'use client'

import { useRouter } from 'next/navigation'
import { useActionState, useEffect } from 'react'
import { toast } from 'sonner'
import { createGroupAction, type GroupActionState } from '@/lib/actions/groups'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'

/** A name and a button. When the group is made the person goes straight to it to add cameras. */
export function CreateGroupForm() {
  const router = useRouter()
  const [state, action, pending] = useActionState<GroupActionState, FormData>(createGroupAction, {})

  useEffect(() => {
    if (state.ok && state.groupId) {
      toast.success(state.message ?? 'Group created.')
      router.push(`/groups/${state.groupId}`)
    }
  }, [state, router])

  return (
    <section className="rounded-xl border bg-card p-4" aria-labelledby="create-group-title">
      <h2 id="create-group-title" className="mb-3 font-medium">Make a group</h2>
      <form action={action} className="flex flex-col gap-2 sm:flex-row sm:items-end">
        <div className="min-w-0 flex-1 space-y-1.5 sm:max-w-sm">
          <Label htmlFor="group-name">Group name</Label>
          <Input id="group-name" name="name" maxLength={100} required autoComplete="off" placeholder="For example: Entrance doors" defaultValue={state.values?.name ?? ''} aria-describedby={state.error ? 'group-name-error' : undefined} aria-invalid={state.error ? true : undefined} />
        </div>
        <Button type="submit" disabled={pending}>{pending ? 'Making…' : 'Make group'}</Button>
      </form>
      {state.error && <p id="group-name-error" role="alert" className="mt-2 text-sm text-destructive">{state.error}</p>}
    </section>
  )
}
