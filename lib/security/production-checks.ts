import { isProductionMode } from '@/lib/runtime-mode'
import { cspReportOnly } from '@/lib/web/csp'

// Release 1 final fix round, builder Y. What a production installation must not start with, kept out of the shared start-up files (each
// self-check calls this with one line):
//   final review A I-1 / B I-1  two-step sign-in may not depend on a remembered manual step: the production web app refuses to start
//                               while an active organisation has it off without an audited opt-out (security_set_mfa with a reason);
//                               an opt-out starts with a warning. The Health page judges the same (mfaHealthCheck).
//   final review B minor 3     the settings TLS and the strict CSP depend on: the web app's own https address, a policy that blocks
//                               (not report-only), video over TLS; the gateway listens on this computer only (behind the TLS proxy).
// Development: nothing is asked and nothing is refused. Never a secret in a message.

type Env = Record<string, string | undefined>
export type Findings = { problems: string[]; warnings: string[] }
/** One row of security_mfa_overview() (migration 20261021000049). */
export type MfaOverviewRow = { org_id: string; enforced: boolean; opted_out: boolean; reason: string | null; off_at: string | null }

const LOOPBACK = new Set(['127.0.0.1', '::1'])
const RUNBOOK = 'docs/drishti/runbook-tls.md'

/** The settings TLS and the strict policy depend on (B minor 3). `proc`: the process that starts. */
export function productionConfigFindings(proc: 'web' | 'gateway', env: Env = process.env): Findings {
  const out: Findings = { problems: [], warnings: [] }
  if (!isProductionMode(env)) return out
  if (proc === 'gateway') {
    const host = (env.GATEWAY_HOST ?? '').trim()
    if (!LOOPBACK.has(host)) {
      out.problems.push(`GATEWAY_HOST must be 127.0.0.1 (or ::1) in production: the video gateway listens on this computer only and the TLS proxy is the one listener on the network; ${host ? 'another address' : 'without it every address'} would offer plain, unencrypted video to the network (${RUNBOOK}).`)
    }
    return out
  }
  const app = (env.NEXT_PUBLIC_APP_URL ?? '').trim()
  let appOrigin = ''
  if (!app) {
    out.problems.push(`NEXT_PUBLIC_APP_URL is not set: production needs the one https address people open (Secure cookies, HSTS and the pinned page address depend on it; ${RUNBOOK}).`)
  } else {
    try {
      const u = new URL(app)
      appOrigin = u.origin
      if (u.protocol !== 'https:') out.problems.push(`NEXT_PUBLIC_APP_URL must be an https address in production (cookies would not be Secure and there would be no HSTS; ${RUNBOOK}).`)
    } catch {
      out.problems.push(`NEXT_PUBLIC_APP_URL is not an address; production needs the one https address people open (${RUNBOOK}).`)
    }
  }
  if (cspReportOnly(env)) {
    out.problems.push('CSP_REPORT_ONLY is on: the content security policy only reports and blocks nothing. It is for a short trial, never production: remove it.')
  }
  const gw = (env.NEXT_PUBLIC_STREAM_GATEWAY_URL ?? '').trim()
  if (gw && !gw.startsWith('/')) {
    let ok = false
    try {
      const u = new URL(gw)
      ok = u.protocol === 'wss:' || u.protocol === 'https:' || (appOrigin !== '' && u.origin === appOrigin)
    } catch {
      ok = false
    }
    if (!ok) out.problems.push(`NEXT_PUBLIC_STREAM_GATEWAY_URL must be a path of the app's address (/) or a wss/https address in production: video would otherwise travel unencrypted (${RUNBOOK}).`)
  }
  return out
}

/** Two-step sign-in of every active organisation (A I-1, B I-1). */
export function mfaStartupFindings(rows: MfaOverviewRow[]): Findings {
  const out: Findings = { problems: [], warnings: [] }
  const off = rows.filter((r) => !r.enforced && !r.opted_out)
  const opted = rows.filter((r) => !r.enforced && r.opted_out)
  if (off.length > 0) {
    out.problems.push(`${off.length} ${off.length === 1 ? 'organisation has' : 'organisations have'} two-step sign-in switched off with no recorded reason. Production requires it for administrators and for exports (decision D-10a). Switch it on (Health page, or as the database owner: SELECT public.security_set_mfa('<organisation id>', NULL, true);) after the administrators have set up their authenticator apps, or record why it stays off: SELECT public.security_set_mfa('<organisation id>', NULL, false, '<reason, 10 to 500 characters>'); (docs/drishti/runbook-tls.md section 5).`)
  }
  for (const r of opted) {
    out.warnings.push(`Two-step sign-in is switched off on purpose for organisation ${r.org_id} (since ${r.off_at ?? 'an unknown time'}; the reason is in the audit log): administrators and exports work with a password only until it is switched on again.`)
  }
  return out
}

/** The web app's production checks of this file: configuration, then two-step sign-in (one database question; unreadable = refused). */
export async function securityStartupProblems(env: Env, deps: { mfaOverview: () => Promise<MfaOverviewRow[]> }): Promise<Findings> {
  const out = productionConfigFindings('web', env)
  if (!isProductionMode(env)) return out
  try {
    const m = mfaStartupFindings(await deps.mfaOverview())
    out.problems.push(...m.problems)
    out.warnings.push(...m.warnings)
  } catch {
    out.problems.push('Two-step sign-in could not be checked (security_mfa_overview(); is the database at migration 20261021000049 and reachable with SUPABASE_APP_WEB_KEY?).')
  }
  return out
}

export type MfaHealthCheck = { key: 'mfa'; label: string; state: 'ok' | 'warning' | 'failed' | 'unknown'; summary: string; facts: [string, string][] }
type MfaCounts = { active: number; enforced: number; off: number; opted_out: number }

/** The Health page's check (ops_health_status().mfa, migration 20261021000049): failed in production while it is off without an opt-out. */
export function mfaHealthCheck(status: { mfa?: MfaCounts } | null | undefined, production: boolean): MfaHealthCheck {
  const base = { key: 'mfa' as const, label: 'Two-step sign-in' }
  const m = status?.mfa
  if (!m) return { ...base, state: 'unknown', summary: 'Not known: the database does not report it (migration 20261021000049).', facts: [] }
  const facts: [string, string][] = [['Organisations', String(m.active)], ['Required', String(m.enforced)], ['Off on purpose (audited)', String(m.opted_out)], ['Off with no reason', String(m.off)]]
  const n = (k: number, one: string, many: string) => `${k} ${k === 1 ? one : many}`
  if (m.off > 0 && production) {
    return { ...base, state: 'failed', facts, summary: `${n(m.off, 'organisation has', 'organisations have')} two-step sign-in switched off with no recorded reason: administrators and exports work with a password only. Switch it on, or record why it stays off (docs/drishti/runbook-tls.md section 5).` }
  }
  if (m.opted_out > 0) {
    return { ...base, state: 'warning', facts, summary: `Switched off on purpose for ${n(m.opted_out, 'organisation', 'organisations')} (the reason and who did it are in the audit log). Switch it on again as soon as the administrators have their authenticator apps.` }
  }
  if (m.off > 0) return { ...base, state: 'ok', facts, summary: `Off for ${n(m.off, 'organisation', 'organisations')}: fine on a development stack; production requires it.` }
  return { ...base, state: 'ok', facts, summary: `Required for administrators and exports in ${n(m.enforced, 'organisation', 'organisations')}.` }
}
