'use client'

import { Home, Server, Store } from 'lucide-react'
import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { cn } from '@/lib/utils'

// Bottom bar for phones: the three pages everybody uses. Admin pages are used on a computer.
const ITEMS = [
  { href: '/home', label: 'Home', Icon: Home },
  { href: '/stores', label: 'Stores', Icon: Store },
  { href: '/devices', label: 'Devices', Icon: Server },
]

export function MobileNav() {
  const pathname = usePathname()
  return (
    <nav className="fixed inset-x-0 bottom-0 z-40 flex border-t bg-background md:hidden">
      {ITEMS.map(({ href, label, Icon }) => (
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
      ))}
    </nav>
  )
}
