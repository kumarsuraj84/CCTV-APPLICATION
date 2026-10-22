'use client'

import { useSyncExternalStore } from 'react'
import { resolveGatewayBase } from '@/lib/streams/wall'

// P3-1 brief item 3: the gateway address follows the address the page was opened with (lib/streams/wall.ts resolveGatewayBase), so the
// same build works on the hub (http://localhost:3212), from another PC (http://10.0.0.47:3212) and behind one TLS address (`/`).
// Read here so the build inlines them for the browser (only NEXT_PUBLIC_ names reach client code).
const CONFIGURED = process.env.NEXT_PUBLIC_STREAM_GATEWAY_URL
const PORT = process.env.NEXT_PUBLIC_STREAM_GATEWAY_PORT

/** The gateway address for this page in the browser, or null when there is none to be had. */
export function clientGatewayBase(): string | null {
  if (typeof window === 'undefined') return resolveGatewayBase(CONFIGURED, null, { port: PORT })
  const { protocol, host, hostname } = window.location
  return resolveGatewayBase(CONFIGURED, { protocol, host, hostname }, { port: PORT })
}

const noSubscribe = () => () => {}
/** While the page is rendered on the server the address is not known yet (`undefined`), so nothing claims video is unavailable. */
const serverSnapshot = (): string | null | undefined => undefined

/** The gateway address (null: none; undefined: not known yet, on the server and during hydration). */
export function useGatewayBase(): string | null | undefined {
  return useSyncExternalStore(noSubscribe, clientGatewayBase, serverSnapshot)
}
