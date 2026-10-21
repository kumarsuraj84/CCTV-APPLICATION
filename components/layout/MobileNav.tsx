'use client'

import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { cn } from '@/lib/utils'
import type { NavItem } from '@/lib/nav'
import { ICONS } from './icons'

// Bottom bar for phones: the pages marked `mobile` in the shared navigation list. Admin pages are used on a computer.
export function MobileNav({ items }: { items: NavItem[] }) {
  const pathname = usePathname()
  return (
    <nav className="fixed inset-x-0 bottom-0 z-40 flex border-t bg-background md:hidden">
      {items.map(({ href, label, icon }) => {
        const Icon = ICONS[icon]
        return (
          <Link
            key={href}
            href={href}
            className={cn(
              'flex flex-1 flex-col items-center gap-0.5 py-2 text-xs text-muted-foreground',
              pathname.startsWith(href) && 'text-foreground font-medium',
            )}
          >
            <Icon className="size-5" />
            {label}
          </Link>
        )
      })}
    </nav>
  )
}
