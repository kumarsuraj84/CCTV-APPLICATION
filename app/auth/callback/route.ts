import { NextResponse, type NextRequest } from 'next/server'
import { safeNext } from '@/lib/auth/safe-next'
import { createClient } from '@/lib/supabase/server'

// The link in the password-reset e-mail lands here with a one-time code, which is exchanged for a signed-in session.
export async function GET(request: NextRequest) {
  const base = process.env.NEXT_PUBLIC_APP_URL || request.url
  const code = request.nextUrl.searchParams.get('code')
  const next = safeNext(request.nextUrl.searchParams.get('next'), '/home')
  if (code) {
    const supabase = await createClient()
    const { error } = await supabase.auth.exchangeCodeForSession(code)
    if (!error) return NextResponse.redirect(new URL(next, base))
  }
  return NextResponse.redirect(new URL('/login?error=link', base))
}
