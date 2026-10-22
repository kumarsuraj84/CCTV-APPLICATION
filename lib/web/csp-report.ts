// CSP violation reports (P3-1): what is kept of a browser's report. Only the directive, the blocked ORIGIN (or a keyword such as
// `inline` / `eval`) and the page PATH: a full address may carry a token (the video socket) or ids in its query.

export type ReportSummary = { directive: string; blocked: string | null; page: string | null; disposition: string | null }

const short = (v: unknown, max = 64): string | null => (typeof v === 'string' && v.length > 0 && v.length <= max ? v : null)

function originOf(v: unknown): string | null {
  if (typeof v !== 'string' || v.length === 0 || v.length > 2048) return null
  if (/^[a-z-]+$/.test(v)) return v.slice(0, 32) // inline, eval, data, blob, self …
  try {
    const u = new URL(v)
    return u.origin === 'null' ? `${u.protocol}` : u.origin
  } catch {
    return null
  }
}

function pathOf(v: unknown): string | null {
  if (typeof v !== 'string' || v.length > 2048) return null
  try {
    return new URL(v).pathname.slice(0, 200)
  } catch {
    return null
  }
}

function one(r: Record<string, unknown>): ReportSummary | null {
  const directive = short(r['effective-directive'] ?? r.effectiveDirective ?? r['violated-directive'] ?? r.violatedDirective)
  if (!directive || !/^[a-z-]+$/.test(directive)) return null
  return {
    directive,
    blocked: originOf(r['blocked-uri'] ?? r.blockedURL),
    page: pathOf(r['document-uri'] ?? r.documentURL),
    disposition: short(r.disposition, 16),
  }
}

/** Reads the old (`{"csp-report": …}`) and the new (Reporting API: `[{ type, body }]`) formats. */
export function summariseReport(json: unknown): ReportSummary[] {
  const items: unknown[] = Array.isArray(json)
    ? json.map((x) => (typeof x === 'object' && x !== null ? (x as { body?: unknown }).body : null))
    : [typeof json === 'object' && json !== null ? (json as { 'csp-report'?: unknown })['csp-report'] : null]
  return items
    .filter((x): x is Record<string, unknown> => typeof x === 'object' && x !== null)
    .slice(0, 20)
    .map(one)
    .filter((x): x is ReportSummary => x !== null)
}
