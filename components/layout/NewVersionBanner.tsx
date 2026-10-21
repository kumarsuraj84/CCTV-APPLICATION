'use client'

import { useEffect, useState } from 'react'

// Tells people to refresh after a new version is installed (the build id changes).
export function NewVersionBanner() {
  const [stale, setStale] = useState(false)

  useEffect(() => {
    const mine = process.env.NEXT_PUBLIC_BUILD_ID || 'dev'
    const timer = setInterval(async () => {
      try {
        const res = await fetch('/api/version', { cache: 'no-store' })
        const { build } = (await res.json()) as { build: string }
        setStale(build !== mine)
      } catch {
        // The server may be restarting; try again next time.
      }
    }, 60_000)
    return () => clearInterval(timer)
  }, [])

  if (!stale) return null
  return (
    <div className="bg-primary px-4 py-2 text-center text-sm text-primary-foreground">
      A new version is ready.{' '}
      <button className="underline" onClick={() => window.location.reload()}>
        Refresh the page
      </button>
    </div>
  )
}
