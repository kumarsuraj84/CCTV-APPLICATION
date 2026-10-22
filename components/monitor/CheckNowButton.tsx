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
          const res = await requestCheckNowAction()
          if (res.error) toast.error(res.error)
          else toast.success(res.message ?? 'Check requested. New results appear within a minute.')
        })
      }
    >
      {pending ? 'Asking…' : 'Check now'}
    </Button>
  )
}
