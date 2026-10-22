import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import path from 'node:path'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'

// P3-1 brief item 6 (shell polish) and the P3-0 leftovers: role words from the one ROLE_LABELS list, a Security link next to Sign out,
// breadcrumbs and navigation that announce where you are, a loading state for every signed-in page, no bare dropdowns with their own
// look, titles on every page, codes and addresses kept away from browser translation, empty states on the design tokens.

vi.mock('next/navigation', () => ({ usePathname: () => '/live', redirect: vi.fn(), useRouter: () => ({ refresh: vi.fn() }) }))
vi.mock('@/lib/actions/auth', () => ({ signIn: vi.fn(), signOut: vi.fn(), forgotPassword: vi.fn(), changePassword: vi.fn() }))

const ROOT = path.resolve(__dirname, '../..')
const read = (p: string) => readFileSync(path.join(ROOT, p), 'utf8')
function files(dir: string, re: RegExp, out: string[] = []): string[] {
  for (const e of readdirSync(path.join(ROOT, dir))) {
    const p = path.join(dir, e)
    if (statSync(path.join(ROOT, p)).isDirectory()) files(p, re, out)
    else if (re.test(e)) out.push(p)
  }
  return out
}

describe('top bar', () => {
  it('uses the shared role words (ROLE_LABELS) and links to the Security page', async () => {
    const { AppShell } = await import('@/components/layout/AppShell')
    const html = renderToStaticMarkup(<AppShell profile={{ full_name: 'Asha Rao', role: 'platform_owner', capabilities: { failed: false, grants: {} } }}>page</AppShell>)
    expect(html).toContain('>Super administrator<')
    expect(html).toMatch(/href="\/account\/security"[^>]*>[^<]*(<[^>]+>)*[^<]*Security/)
    expect(read('components/layout/AppShell.tsx')).not.toContain('ROLE_WORDS')
    expect(read('components/layout/AppShell.tsx')).toContain('ROLE_LABELS')
  })
})

describe('where you are', () => {
  it('breadcrumbs are a named navigation with the current page marked', async () => {
    const { PageHeader } = await import('@/components/ui/PageHeader')
    const html = renderToStaticMarkup(<PageHeader title="Access" breadcrumbs={[{ label: 'Users', href: '/admin/users' }, { label: 'Access' }]} />)
    expect(html).toContain('aria-label="Breadcrumb"')
    expect(html).toMatch(/aria-current="page"[^>]*>Access</)
    expect(html).toMatch(/<a[^>]*class="[^"]*focus-visible:outline/)
  })

  it('the phone bar is a named navigation with the current page marked', async () => {
    const { MobileNav } = await import('@/components/layout/MobileNav')
    const html = renderToStaticMarkup(<MobileNav items={[{ href: '/home', label: 'Home', icon: 'home', group: 'Monitoring', mobile: true } as never, { href: '/live', label: 'Live', icon: 'video', group: 'Monitoring', mobile: true } as never]} />)
    expect(html).toContain('aria-label="Main"')
    expect(html).toMatch(/href="\/live"[^>]*aria-current="page"|aria-current="page"[^>]*href="\/live"/)
    expect(html).not.toMatch(/href="\/home"[^>]*aria-current/)
  })
})

describe('states', () => {
  it('every signed-in page has a loading state that is announced', async () => {
    expect(existsSync(path.join(ROOT, 'app/(app)/loading.tsx'))).toBe(true)
    const { default: Loading } = await import('@/app/(app)/loading')
    const html = renderToStaticMarkup(<Loading />)
    expect(html).toContain('role="status"')
    expect(html).toContain('Loading')
  })

  it('the empty state uses the design tokens, not fixed colours', () => {
    expect(read('components/ui/EmptyState.tsx')).not.toMatch(/#[0-9A-Fa-f]{3,6}\b/)
  })
})

describe('P3-0 leftovers', () => {
  it('no bare <select> with its own look: every dropdown is components/ui/select.tsx', () => {
    const offenders = [...files('components', /\.tsx$/), ...files('app', /\.tsx$/)].filter((f) => !f.replace(/\\/g, '/').endsWith('components/ui/select.tsx') && /<select\b/.test(read(f)))
    expect(offenders).toEqual([])
  })

  it('every page has its own title', () => {
    const exempt = new Set(['app/page.tsx', 'app/(auth)/reset-password/page.tsx']) // both only redirect
    const missing = files('app', /^page\.tsx$/).map((f) => f.replace(/\\/g, '/')).filter((f) => !exempt.has(f) && !/export (const metadata|async function generateMetadata)/.test(read(f)))
    expect(missing).toEqual([])
  })
})

describe('browser translation', () => {
  it('location codes on the wall and the people list addresses are marked translate="no"', () => {
    expect(read('components/live/LiveTile.tsx')).toMatch(/translate="no"[^>]*>\{camera\.storeCode\}|<span[^>]*translate="no"[^>]*>\{camera\.storeCode\}/)
    expect(read('components/admin/UserRow.tsx')).toMatch(/translate="no">\{u\.email\}/)
  })
})
