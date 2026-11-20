import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import { moreNavFor, type NavItem } from '@/lib/nav'

// Final fix Y (final review C M-14): on a phone the bottom bar holds four pages; every other page the person may open (Playback,
// Groups, Wi-Fi, the admin pages) is one tap away under "More", a disclosure that works without script.

vi.mock('next/navigation', () => ({ usePathname: () => '/groups' }))

const grant = { organization: true, locations: [], cameras: [], assets: [] }
const caps = (list: string[]) => ({ failed: false, grants: Object.fromEntries(list.map((c) => [c, grant])) }) as never

describe('the phone menu (C M-14)', () => {
  it('"More" lists every allowed page that is not on the bar', () => {
    const viewer = { role: 'admin' as const, capabilities: caps(['cctv.live', 'cctv.playback', 'wifi.inventory.view', 'admin.users']) }
    const more = moreNavFor(viewer).map((i) => i.href)
    expect(more).toEqual(expect.arrayContaining(['/playback', '/groups', '/locations/wifi', '/admin/users']))
    expect(more).not.toContain('/home')
    expect(more).not.toContain('/live')
    expect(moreNavFor({ role: 'user', capabilities: caps([]) })).toEqual([])
  })

  it('renders as a named disclosure with real links, the current page marked', async () => {
    const { MobileNav } = await import('@/components/layout/MobileNav')
    const bar: NavItem[] = [{ href: '/home', label: 'Home', icon: 'home', group: 'Overview', mobile: true }]
    const more: NavItem[] = [{ href: '/groups', label: 'Groups', icon: 'grid', group: 'CCTV Monitoring' }, { href: '/admin/users', label: 'Users', icon: 'users', group: 'Admin' }]
    const html = renderToStaticMarkup(<MobileNav items={bar} more={more} />)
    expect(html).toContain('<summary')
    expect(html).toMatch(/More/)
    expect(html.match(/<a [^>]*href="\/groups"[^>]*>/)?.[0]).toContain('aria-current="page"')
    expect(html).toContain('href="/admin/users"')
    expect(renderToStaticMarkup(<MobileNav items={bar} more={[]} />)).not.toContain('<summary')
  })
})
