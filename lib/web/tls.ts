import { isIP } from 'node:net'

// TLS readiness (P3-1 brief item 4; docs/drishti/runbook-tls.md). Behind the one https address (Caddy on Windows) the web app and the
// video gateway listen on this computer only; the reverse proxy is the only thing on the network.

/** The address the gateway listens on: GATEWAY_HOST when it is an IP address (127.0.0.1 behind the proxy), else every address (today). */
export function gatewayBindHost(env: Record<string, string | undefined> = process.env): string {
  const v = (env.GATEWAY_HOST ?? '').trim()
  return v !== '' && isIP(v) !== 0 ? v : '0.0.0.0'
}
