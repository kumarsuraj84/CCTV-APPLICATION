'use client'

import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { cn } from '@/lib/utils'
import type { NavItem } from '@/lib/nav'
import { BRAND } from '@/lib/brand'
import { ICONS } from './icons'

export function Sidebar({ items }: { items: NavItem[] }) {
  const pathname = usePathname()
  const groups = ['Monitoring', 'Admin'] as const
  return (
    <aside className="hidden w-60 shrink-0 flex-col border-r bg-sidebar text-sidebar-foreground md:flex">
      <div className="px-5 py-4">
        <div className="text-base font-semibold">{BRAND.name}</div>
        <div className="text-xs text-muted-foreground">{BRAND.subtitle}</div>
      </div>
      <nav className="flex-1 space-y-4 overflow-y-auto px-3 pb-4">
        {groups.map((group) => {
          const list = items.filter((i) => i.group === group)
          if (list.length === 0) return null
          return (
            <div key={group}>
              <div className="px-2 pb-1 text-xs font-medium uppercase tracking-wide text-muted-foreground">{group}</div>
              <ul className="space-y-0.5">
                {list.map((item) => {
                  const Icon = ICONS[item.icon]
                  const active = pathname === item.href || pathname.startsWith(item.href + '/')
                  return (
                    <li key={item.href}>
                      <Link
                        href={item.href}
                        className={cn(
                          'flex items-center gap-2 rounded-lg px-2 py-1.5 text-sm hover:bg-sidebar-accent',
                          active && 'bg-sidebar-accent font-medium',
                        )}
                      >
                        <Icon className="size-4" />
                        {item.label}
                      </Link>
                    </li>
                  )
                })}
              </ul>
            </div>
          )
        })}
      </nav>
    </aside>
  )
}
