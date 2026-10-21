import { createServerClient, type CookieOptions } from '@supabase/ssr'
import { NextResponse, type NextRequest } from 'next/server'
import { VERIFIED_USER_HEADER, VERIFIED_USER_SIG_HEADER, signVerifiedUser } from '@/lib/auth/verified-user'

// Public pages and routes are an exact-match list. Every other path needs a signed-in person.
const PUBLIC_PAGES = new Set(['/login', '/forgot-password'])
const PUBLIC_API = new Set(['/api/health', '/api/version'])

function stamp(headers: Headers, request: NextRequest) {
  headers.set('x-request-id', crypto.randomUUID())
  headers.set('x-request-path', request.nextUrl.pathname)
  headers.set('x-request-method', request.method)
}

// A client may send any copy of the verified-user headers; it is always removed here and only set again below, signed.
function cleanHeaders(request: NextRequest): Headers {
  const h = new Headers(request.headers)
  h.delete(VERIFIED_USER_HEADER)
  h.delete(VERIFIED_USER_SIG_HEADER)
  stamp(h, request)
  return h
}

export async function proxy(request: NextRequest) {
  const { pathname } = request.nextUrl
  const isAsset = pathname.startsWith('/_next') || pathname.startsWith('/favicon') || /^\/[A-Za-z0-9._-]+\.(svg|png|jpg|jpeg|gif|webp|ico)$/.test(pathname)
  if (isAsset || PUBLIC_API.has(pathname) || pathname.startsWith('/auth/callback')) {
    return NextResponse.next({ request: { headers: cleanHeaders(request) } })
  }

  const forwarded = cleanHeaders(request)
  const secure = (process.env.NEXT_PUBLIC_APP_URL ?? '').startsWith('https')
  let refreshed: { name: string; value: string; options: CookieOptions }[] = []

  const supabase = createServerClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!, {
    cookies: {
      getAll: () => request.cookies.getAll(),
      setAll(list) {
        refreshed = list
        list.forEach(({ name, value }) => request.cookies.set(name, value))
      },
    },
  })
  const { data: { user } } = await supabase.auth.getUser()

  if (!user && !PUBLIC_PAGES.has(pathname) && pathname !== '/reset-password') {
    const url = request.nextUrl.clone()
    url.pathname = '/login'
    url.search = ''
    url.searchParams.set('next', pathname + request.nextUrl.search)
    return NextResponse.redirect(url)
  }

  const sig = signVerifiedUser(user?.id ?? '')
  if (sig) {
    forwarded.set(VERIFIED_USER_HEADER, user?.id ?? '')
    forwarded.set(VERIFIED_USER_SIG_HEADER, sig)
  }
  forwarded.set('cookie', request.cookies.toString())

  const response = NextResponse.next({ request: { headers: forwarded } })
  refreshed.forEach(({ name, value, options }) => response.cookies.set(name, value, secure ? { ...options, secure: true } : options))
  return response
}

export const config = { matcher: ['/((?!_next/static|_next/image|favicon.ico).*)'] }
