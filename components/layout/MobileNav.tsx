'use client'

import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { cn } from '@/lib/utils'
import type { NavItem } from '@/lib/nav'
import { ICONS } from './icons'

// Bottom bar for phones (below md, where the sidebar is hidden): the pages marked `mobile` in the shared navigation list. P3-1: a named
// navigation, the current page marked for screen readers, visible keyboard focus. Final fix Y (final review C M-14): every other page
// the person may open (Playback, Groups, Wi-Fi, the admin pages) is under "More", a disclosure (works without script).
const ITEM = 'flex min-h-12 flex-1 flex-col items-center justify-center gap-0.5 py-2 text-xs text-muted-foreground focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-[var(--ring)]'

export function MobileNav({ items, more = [] }: { items: NavItem[]; more?: NavItem[] }) {
  const pathname = usePathname()
  // The most specific match wins (/locations/wifi is not "Locations").
  const current = [...items, ...more].map((i) => i.href).filter((h) => pathname === h || pathname.startsWith(h + '/')).sort((a, b) => b.length - a.length)[0]
  const MoreIcon = ICONS.grid
  return (
    <nav aria-label="Main" className="fixed inset-x-0 bottom-0 z-40 flex border-t bg-background pb-[env(safe-area-inset-bottom)] md:hidden">
      {items.map(({ href, label, mobileLabel, icon }) => {
        const Icon = ICONS[icon]
        const active = href === current
        return (
          <Link key={href} href={href} aria-current={active ? 'page' : undefined} className={cn(ITEM, active && 'font-medium text-foreground')}>
            <Icon aria-hidden="true" className="size-5" />
            {mobileLabel ?? label}
          </Link>
        )
      })}
      {more.length > 0 && (
        <details className="group flex flex-1">
          <summary className={cn(ITEM, 'cursor-pointer list-none', more.some((i) => i.href === current) && 'font-medium text-foreground')}>
            <MoreIcon aria-hidden="true" className="size-5" />
            More
          </summary>
          <ul className="absolute inset-x-0 bottom-full max-h-[70vh] overflow-y-auto border-t bg-background p-2 shadow-lg">
            {more.map(({ href, label, icon }) => {
              const Icon = ICONS[icon]
              const active = href === current
              return (
                <li key={href}>
                  <Link href={href} aria-current={active ? 'page' : undefined}
                    className={cn('flex min-h-11 items-center gap-3 rounded-md px-3 text-base focus-visible:outline-2 focus-visible:outline-[var(--ring)]', active && 'font-medium')}>
                    <Icon aria-hidden="true" className="size-5" />
                    {label}
                  </Link>
                </li>
              )
            })}
          </ul>
        </details>
      )}
    </nav>
  )
}
