'use client'

import { useState, useTransition } from 'react'
import { toast } from 'sonner'
import type { FormResult } from '@/lib/actions/admin/inventory'
import { Button } from '@/components/ui/button'

// Two clicks to delete, with the confirmation inside the page (no browser dialog).
export function DeleteButton({ onDelete, label = 'Delete' }: { onDelete: () => Promise<FormResult>; label?: string }) {
  const [armed, setArmed] = useState(false)
  const [pending, start] = useTransition()
  if (!armed) return <Button size="sm" variant="outline" onClick={() => setArmed(true)}>{label}</Button>
  return (
    <span className="inline-flex gap-1">
      <Button size="sm" variant="destructive" disabled={pending} onClick={() => start(async () => {
        const res = await onDelete()
        if (res.error) toast.error(res.error)
        else toast.success('Deleted.')
        setArmed(false)
      })}>Yes, delete</Button>
      <Button size="sm" variant="ghost" onClick={() => setArmed(false)}>Cancel</Button>
    </span>
  )
}
