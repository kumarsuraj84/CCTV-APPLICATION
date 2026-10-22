'use client'

import { useTransition } from 'react'
import { toast } from 'sonner'
import { requestCheckNowAction } from '@/lib/actions/monitor'
import { Button } from '@/components/ui/button'

export function CheckNowButton() {
  const [pending, start] = useTransition()
  return (
    <Button
      variant="outline"
      disabled={pending}
      onClick={() =>
        start(async () => {
          try {
            const res = await requestCheckNowAction()
            if (res.error) toast.error(res.error)
            else toast.success(res.message ?? 'Check requested. New results appear within a minute.')
          } catch {
            // The call itself failed (network down, server restarting): say so plainly.
            toast.error('Could not send the request. Check your connection and try again.')
          }
        })
      }
    >
      {pending ? 'Asking…' : 'Check now'}
    </Button>
  )
}
