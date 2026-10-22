'use client'

import { useTransition } from 'react'
import { toast } from 'sonner'
import { discoverCamerasAction } from '@/lib/actions/admin/monitoring'
import { Button } from '@/components/ui/button'

export function FindCamerasButton({ storeId }: { storeId: string }) {
  const [pending, start] = useTransition()
  return (
    <Button
      size="sm"
      variant="outline"
      disabled={pending}
      onClick={() =>
        start(async () => {
          const res = await discoverCamerasAction(storeId)
          if (res.error) toast.error(res.error)
          else toast.success(res.message ?? 'Done.')
        })
      }
    >
      {pending ? 'Looking…' : 'Find cameras'}
    </Button>
  )
}
