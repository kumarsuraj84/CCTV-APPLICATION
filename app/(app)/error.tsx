'use client' // Error boundaries must be Client Components

import { TriangleAlert } from 'lucide-react'
import { Button } from '@/components/ui/button'

/** Shown instead of a screen that could not load. Says nothing about the cause: that goes to the server log, not to the person. */
export default function AppError({ retry }: { error: Error & { digest?: string }; retry: () => void }) {
  return (
    <div role="alert" className="mx-auto flex max-w-md flex-col items-center gap-3 rounded-xl border bg-card p-6 text-center">
      <TriangleAlert aria-hidden="true" className="size-6 text-muted-foreground" />
      <h2 className="font-medium">Something went wrong loading this page. Try again.</h2>
      <p className="text-sm text-muted-foreground">If it keeps happening, tell an administrator.</p>
      <Button variant="outline" onClick={() => retry()}>Try again</Button>
    </div>
  )
}
