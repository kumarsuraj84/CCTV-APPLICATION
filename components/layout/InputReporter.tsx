'use client'

import { useEffect } from 'react'
import { installInputTracker } from './input-tracker'

/**
 * P4-L1 review I-2: reports the person's last real input to the proxy (cookie drishti-input) on every signed-in page. Shows nothing.
 * Fix round 2 (N-2): `serverNow` is the server's time when the page was rendered, so the cookie is written in the server's clock.
 */
export function InputReporter({ serverNow }: { serverNow?: number }) {
  useEffect(() => {
    installInputTracker(serverNow)
  }, [serverNow])
  return null
}
