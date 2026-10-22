import { Loader2 } from 'lucide-react'

// P3-1: shown while a signed-in page is being prepared (Next.js loading convention), announced to screen readers.
export default function Loading() {
  return (
    <div role="status" aria-live="polite" className="flex min-h-40 items-center justify-center gap-2 text-sm text-muted-foreground">
      <Loader2 aria-hidden="true" className="size-4 animate-spin" />
      Loading…
    </div>
  )
}
