// T-1 (ruling T-1): "Store" became "Location"; the old addresses keep working with permanent redirects that keep the id and the query.
// P3-1: answered by proxy.ts (before sign-in, as next.config's redirects were) so that the redirect carries the security headers too —
// Next.js sends a redirect of next.config.ts with no headers at all (seen on the built server: no CSP, no X-Frame-Options).

const UUID = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/

/** The new address (path and the whole query) for an old one, or null. Always permanent (308). */
export function legacyRedirect(pathname: string, search: string): string | null {
  const query = search && search !== '?' ? (search.startsWith('?') ? search : `?${search}`) : ''
  if (pathname === '/stores') return `/locations${query}`
  const one = /^\/stores\/([^/]+)$/.exec(pathname)
  if (one) return `/locations/${one[1]}${query}`
  if (pathname === '/admin/stores') {
    // The old edit link of the "Manage stores" page opens that location on its administration page (only a real id goes into the path).
    const edit = new URLSearchParams(query).get('edit')
    return edit && UUID.test(edit) ? `/admin/locations/${edit}${query}` : `/admin/locations${query}`
  }
  return null
}
