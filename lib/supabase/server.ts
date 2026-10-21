import { createServerClient } from '@supabase/ssr'
import { cookies } from 'next/headers'
import type { Database } from '@/types/database'
import { resilientFetch } from '@/lib/supabase/resilient-fetch'

/** Cookie-bound client: acts as the signed-in person and row-level security applies. */
export async function createClient() {
  const cookieStore = await cookies()
  const secure = (process.env.NEXT_PUBLIC_APP_URL ?? '').startsWith('https')
  return createServerClient<Database>(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!, {
    global: { fetch: resilientFetch },
    cookies: {
      getAll() {
        return cookieStore.getAll()
      },
      setAll(list) {
        try {
          list.forEach(({ name, value, options }) => cookieStore.set(name, value, secure ? { ...options, secure: true } : options))
        } catch {
          // Called from a Server Component: proxy.ts refreshes the session instead.
        }
      },
    },
  })
}
