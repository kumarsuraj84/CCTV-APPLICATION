import { randomBytes } from 'node:crypto'
import { gatewayConnectOrigins, resolveGatewayBase, type PageAddress } from '@/lib/streams/wall'

// Content Security Policy (P3-1 brief item 2, decision D-12, tracker SO-8), built per request in proxy.ts as the Next.js 16 guide
// describes (node_modules/next/dist/docs/01-app/02-guides/content-security-policy.md): a fresh nonce per request; Next.js reads it from
// the request's policy header and puts it on its own scripts. Every page is rendered per request (the root layout reads the headers),
// so every page gets its nonce.
//
//   script-src   'self' 'nonce-…' 'strict-dynamic': only scripts carrying this request's nonce run, plus what they load themselves
//                (the go2rtc player script that the live wall adds from the gateway). No inline handlers, no eval in production.
//   connect-src  'self' and the video gateway (its http and ws origin), derived like the browser does (lib/streams/wall.ts), plus an
//                optional allow-list (CSP_CONNECT_EXTRA: comma separated origins). Nothing else: the browser never talks to the database.
//   style-src    'self' 'unsafe-inline': React writes style attributes and the toast library adds a style sheet; a nonce cannot cover
//                either, and style injection cannot run code.
//   img-src      'self' data: blob: (the MFA QR code is a data: image); media-src 'self' blob: (the player's MediaSource pictures).
//   object-src 'none', base-uri 'self', form-action 'self', frame-ancestors 'none', frame-src 'none'; upgrade-insecure-requests on https.
// Development adds 'unsafe-eval' (React's debugging) and the page's own hot-reload socket.

export type CspInput = {
  nonce: string
  dev: boolean
  /** Where the page was opened (the request's scheme and Host). */
  page: PageAddress
  /** NEXT_PUBLIC_STREAM_GATEWAY_URL (unset / `auto` / a path / an address). */
  gateway?: string
  /** NEXT_PUBLIC_STREAM_GATEWAY_PORT. */
  gatewayPort?: string
  /** CSP_CONNECT_EXTRA. */
  extraConnect?: string
  /** The site is served over https (NEXT_PUBLIC_APP_URL). */
  https?: boolean
  reportUri?: string | null
}

const NONCE = /^[A-Za-z0-9+/]+={0,2}$/

/** 128 random bits, base64: unguessable and new for every request. */
export const makeNonce = (): string => randomBytes(16).toString('base64')

/** Origins only (scheme, host, optional port): no wildcard, path, query, credentials or scheme-only source. */
export function cspExtraOrigins(value: string | undefined): string[] {
  const out: string[] = []
  for (const raw of (value ?? '').split(',')) {
    const v = raw.trim()
    if (!/^(?:https?|wss?):\/\/[A-Za-z0-9.-]+(?::\d{1,5})?$/.test(v)) continue
    try {
      const u = new URL(v)
      out.push(`${u.protocol}//${u.host}`)
    } catch {
      // not an origin
    }
  }
  return [...new Set(out)]
}

export function buildCsp(o: CspInput): string {
  if (!NONCE.test(o.nonce)) throw new Error('The CSP nonce must be base64.')
  const gateway = gatewayConnectOrigins(resolveGatewayBase(o.gateway, o.page, { port: o.gatewayPort }))
  const hotReload = o.dev ? [`${o.page.protocol === 'https:' ? 'wss' : 'ws'}://${o.page.host}`] : []
  const connect = [...new Set(["'self'", ...gateway, ...hotReload, ...cspExtraOrigins(o.extraConnect)])]
  const directives: [string, string[]][] = [
    ['default-src', ["'self'"]],
    ['script-src', ["'self'", `'nonce-${o.nonce}'`, "'strict-dynamic'", ...(o.dev ? ["'unsafe-eval'"] : [])]],
    ['style-src', ["'self'", "'unsafe-inline'"]],
    ['img-src', ["'self'", 'data:', 'blob:']],
    ['font-src', ["'self'"]],
    ['media-src', ["'self'", 'blob:']],
    ['connect-src', connect],
    ['worker-src', ["'self'"]],
    ['manifest-src', ["'self'"]],
    ['frame-src', ["'none'"]],
    ['object-src', ["'none'"]],
    ['base-uri', ["'self'"]],
    ['form-action', ["'self'"]],
    ['frame-ancestors', ["'none'"]],
    ...(o.https ? ([['upgrade-insecure-requests', []]] as [string, string[]][]) : []),
    ...(o.reportUri === null ? [] : ([['report-uri', [o.reportUri ?? '/api/csp-report']]] as [string, string[]][])),
  ]
  return directives.map(([k, v]) => (v.length ? `${k} ${v.join(' ')}` : k)).join('; ')
}

/** `CSP_REPORT_ONLY=1` (rollout): the browser reports what it would block, but blocks nothing. */
export const cspHeaderName = (reportOnly: boolean) => (reportOnly ? 'Content-Security-Policy-Report-Only' : 'Content-Security-Policy')
export const cspReportOnly = (env: Record<string, string | undefined> = process.env) => /^(?:1|true|yes|on)$/i.test(env.CSP_REPORT_ONLY ?? '')

/** For answers without content (redirects): nothing may load, nothing may frame it. */
export const REDIRECT_CSP = "default-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'"

/** Directive → sources (tests and the report endpoint). */
export function parseCsp(header: string): Record<string, string[]> {
  const out: Record<string, string[]> = {}
  for (const part of header.split(';')) {
    const [name, ...values] = part.trim().split(/\s+/)
    if (name) out[name.toLowerCase()] = values
  }
  return out
}
