import type { CookieOptions } from '@supabase/ssr'

// P3-1 review I-1: the ONE rule for the sign-in cookies, used by the cookie client of every Server Action and route handler
// (lib/supabase/server.ts) and by the proxy's refresh (proxy.ts). @supabase/ssr writes them readable by page scripts (httpOnly: false);
// no browser code here reads them (there is no browser Supabase client), so they are always HttpOnly, SameSite=Lax, and Secure when
// the site is served over https.

export const siteIsHttps = (env: Record<string, string | undefined> = process.env) => (env.NEXT_PUBLIC_APP_URL ?? '').startsWith('https')

export function authCookieOptions(options: CookieOptions | undefined, https: boolean = siteIsHttps()): CookieOptions {
  return { ...(options ?? {}), httpOnly: true, sameSite: 'lax', ...(https ? { secure: true } : {}) }
}
