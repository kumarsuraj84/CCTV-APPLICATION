import { NextRequest } from 'next/server'
import { describe, expect, it, vi } from 'vitest'

// P3-0: the sign-in page shows the logo from public/brand/, so those image files must load before anyone is signed in. Nothing else
// becomes public: only image files directly inside /brand/ (no deeper paths, no other extensions).

const getUser = vi.fn(async () => ({ data: { user: null } }))
vi.mock('@supabase/ssr', () => ({ createServerClient: () => ({ auth: { getUser } }) }))

const { proxy } = await import('@/proxy')
const run = (p: string) => proxy(new NextRequest(new URL(p, 'http://localhost:3212')))
const redirectedToLogin = (res: Response) => res.status >= 300 && res.status < 400 && (res.headers.get('location') ?? '').includes('/login')

describe('proxy: brand images are public', () => {
  it.each(['/brand/citykart-drishti-logo.png', '/brand/citykart-drishti-logo-925.png', '/brand/citykart-drishti-mark-64.png', '/icon.png', '/apple-icon.png'])(
    '%s loads without signing in',
    async (p) => {
      getUser.mockClear()
      const res = await run(p)
      expect(redirectedToLogin(res)).toBe(false)
      expect(getUser).not.toHaveBeenCalled()
    },
  )

  it.each(['/brand/', '/brand/notes.txt', '/brand/a/b.png', '/brandx/logo.png', '/home', '/admin/users'])('%s still needs a signed-in person', async (p) => {
    const res = await run(p)
    expect(redirectedToLogin(res)).toBe(true)
  })
})
