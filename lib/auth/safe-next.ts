// A "next" address after sign-in must be a path on this site. Anything else (another site, a protocol-relative address) is refused.
export function safeNext(next: string | null | undefined, fallback = '/home'): string {
  if (!next) return fallback
  // The URL parser silently drops tab, CR and LF, so "/<tab>/host" would become "//host". Refuse control and whitespace characters outright.
  if (/[\u0000-\u001f\u007f\s]/.test(next)) return fallback
  if (!next.startsWith('/') || next.startsWith('//') || next.startsWith('/\\')) return fallback
  if (next === '/login' || next.startsWith('/login?') || next.startsWith('/login/')) return fallback
  return next
}
