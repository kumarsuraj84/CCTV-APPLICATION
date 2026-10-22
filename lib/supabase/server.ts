import { createServerClient } from '@supabase/ssr'
import { cookies } from 'next/headers'
import type { Database } from '@/types/database'
import { resilientFetch } from '@/lib/supabase/resilient-fetch'
import { authCookieOptions, siteIsHttps } from '@/lib/supabase/cookie-options'

/** Cookie-bound client: acts as the signed-in person and row-level security applies. */
export async function createClient() {
  const cookieStore = await cookies()
  const https = siteIsHttps()
  return createServerClient<Database>(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!, {
    global: { fetch: resilientFetch },
    cookies: {
      getAll() {
        return cookieStore.getAll()
      },
      setAll(list) {
        try {
          // P3-1 review I-1: HttpOnly, SameSite=Lax, Secure on https — the same rule as the proxy (lib/supabase/cookie-options.ts).
          list.forEach(({ name, value, options }) => cookieStore.set(name, value, authCookieOptions(options, https)))
        } catch {
          // Called from a Server Component: proxy.ts refreshes the session instead.
        }
      },
    },
  })
}
