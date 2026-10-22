'use client'

import { useEffect } from 'react'
import { installInputTracker } from './input-tracker'

/** P4-L1 review I-2: reports the person's last real input to the proxy (cookie drishti-input) on every signed-in page. Shows nothing. */
export function InputReporter() {
  useEffect(() => {
    installInputTracker()
  }, [])
  return null
}
