import { isIP } from 'node:net'
import { isProductionMode } from '@/lib/runtime-mode'

type Env = Record<string, string | undefined>

function privateHost(hostname: string): boolean {
  const h = hostname.replace(/^\[|\]$/g, '').toLowerCase()
  if (h === 'localhost' || h.endsWith('.localhost')) return true
  const v4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(h)
  if (v4) {
    const [a, b] = [Number(v4[1]), Number(v4[2])]
    return a === 127 || a === 10 || (a === 192 && b === 168) || (a === 172 && b >= 16 && b <= 31)
  }
  if (isIP(h) === 6) return h === '::1' || /^f[cd][0-9a-f]{2}:/.test(h) || /^fe[89ab][0-9a-f]:/.test(h)
  // A single-label name (a Docker or Windows host name), a private DNS suffix, or a reserved name that never resolves publicly (RFC 6761).
  return !h.includes('.') || /\.(local|lan|internal|corp|home\.arpa|test|example|invalid)$/.test(h)
}

/**
 * P3-1 review I-5: in production the Supabase API (and with it the auth server) must not be reachable from the internet, or anyone could
 * sign in and try codes directly, around the app's sign-in delay, code count and one-app rule. Null when the configured address is this
 * computer, the private network or the app's own address (one reverse proxy); otherwise the plain problem. A hosted project with its
 * network restrictions switched on is accepted only with DRISHTI_AUTH_URL_PUBLIC_OK=network-restricted (docs/drishti/runbook-tls.md).
 */
export function authUrlProblem(env: Env = process.env): string | null {
  if (!isProductionMode(env)) return null
  const configured = env.NEXT_PUBLIC_SUPABASE_URL?.trim() || env.SUPABASE_URL?.trim() || ''
  let host = ''
  try {
    host = new URL(configured).hostname
  } catch {
    return 'NEXT_PUBLIC_SUPABASE_URL is not an address; it must be this computer or the private network (docs/drishti/runbook-tls.md section 3).'
  }
  if (privateHost(host)) return null
  try {
    if (env.NEXT_PUBLIC_APP_URL && new URL(env.NEXT_PUBLIC_APP_URL).hostname === host) return null
  } catch {
    // no app address to compare with
  }
  if ((env.DRISHTI_AUTH_URL_PUBLIC_OK ?? '').trim() === 'network-restricted') return null
  return `The Supabase address (${host}) is public: the auth server must be reachable only from this computer or the private network, or anyone could sign in and try codes around the app's limits (docs/drishti/runbook-tls.md section 3).`
}

// TLS readiness (P3-1 brief item 4; docs/drishti/runbook-tls.md). Behind the one https address (Caddy on Windows) the web app and the
// video gateway listen on this computer only; the reverse proxy is the only thing on the network.

/** The address the gateway listens on: GATEWAY_HOST when it is an IP address (127.0.0.1 behind the proxy), else every address (today). */
export function gatewayBindHost(env: Record<string, string | undefined> = process.env): string {
  const v = (env.GATEWAY_HOST ?? '').trim()
  return v !== '' && isIP(v) !== 0 ? v : '0.0.0.0'
}
