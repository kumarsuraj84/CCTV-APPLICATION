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
          else {
            const details = res.details ?? []
            toast.success(res.message ?? 'Done.', details.length > 0
              ? { description: <ul className="mt-1 list-disc space-y-0.5 pl-4">{details.map((d, i) => <li key={i}>{d}</li>)}</ul>, duration: 20000 }
              : undefined)
          }
        })
      }
    >
      {pending ? 'Looking…' : 'Find cameras'}
    </Button>
  )
}
