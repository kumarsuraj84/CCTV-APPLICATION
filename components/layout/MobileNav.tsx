'use client'

import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { cn } from '@/lib/utils'
import type { NavItem } from '@/lib/nav'
import { ICONS } from './icons'

// Bottom bar for phones (below md, where the sidebar is hidden): the pages marked `mobile` in the shared navigation list. Admin pages
// are used on a computer. P3-1: a named navigation, the current page marked for screen readers, visible keyboard focus.
export function MobileNav({ items }: { items: NavItem[] }) {
  const pathname = usePathname()
  // The most specific match wins (/locations/wifi is not "Locations").
  const current = items.map((i) => i.href).filter((h) => pathname === h || pathname.startsWith(h + '/')).sort((a, b) => b.length - a.length)[0]
  return (
    <nav aria-label="Main" className="fixed inset-x-0 bottom-0 z-40 flex border-t bg-background pb-[env(safe-area-inset-bottom)] md:hidden">
      {items.map(({ href, label, icon }) => {
        const Icon = ICONS[icon]
        const active = href === current
        return (
          <Link
            key={href}
            href={href}
            aria-current={active ? 'page' : undefined}
            className={cn(
              'flex min-h-12 flex-1 flex-col items-center justify-center gap-0.5 py-2 text-xs text-muted-foreground focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-[var(--ring)]',
              active && 'font-medium text-foreground',
            )}
          >
            <Icon aria-hidden="true" className="size-5" />
            {label}
          </Link>
        )
      })}
    </nav>
  )
}
