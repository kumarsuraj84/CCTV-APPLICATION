'use client'

import { useState, useTransition } from 'react'
import { toast } from 'sonner'
import type { FormResult } from '@/lib/actions/admin/inventory'
import { Button } from '@/components/ui/button'

// Two clicks to delete (or archive), with the confirmation inside the page (no browser dialog). Final fix Y (final review C M-17): the
// words say what really happens (`label`, `confirmLabel`, `doneMessage`), and every button names the item for screen readers.
export function DeleteButton({ onDelete, label = 'Delete', confirmLabel, doneMessage = 'Deleted.', itemName }: {
  onDelete: () => Promise<FormResult>
  label?: string
  confirmLabel?: string
  doneMessage?: string
  itemName?: string
}) {
  const [armed, setArmed] = useState(false)
  const [pending, start] = useTransition()
  const of = itemName ? ` ${itemName}` : ''
  if (!armed) return <Button size="sm" variant="outline" aria-label={`${label}${of}`} onClick={() => setArmed(true)}>{label}</Button>
  const yes = confirmLabel ?? `Yes, ${label.toLowerCase()}`
  return (
    <span className="inline-flex gap-1">
      <Button size="sm" variant="destructive" disabled={pending} aria-label={`${yes}${of}`} onClick={() => start(async () => {
        const res = await onDelete()
        if (res.error) toast.error(res.error)
        else toast.success(doneMessage)
        setArmed(false)
      })}>{yes}</Button>
      <Button size="sm" variant="ghost" aria-label={`Cancel${of ? `:${of}` : ''}`} onClick={() => setArmed(false)}>Cancel</Button>
    </span>
  )
}
