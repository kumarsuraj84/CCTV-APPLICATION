'use client'

import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { cn } from '@/lib/utils'
import type { NavItem } from '@/lib/nav'
import { BrandLogo } from './BrandLogo'
import { ICONS } from './icons'

// Desktop sidebar (md and wider). P3-0: the full CityKart Drishti logo heads it (the sidebar is always expanded, so there is room);
// the navigation items and their capability gating are unchanged (lib/nav.ts).
export function Sidebar({ items }: { items: NavItem[] }) {
  const pathname = usePathname()
  const groups = ['Monitoring', 'Admin'] as const
  return (
    // P3-1: stays in view, full height, while a long page scrolls (it used to end after one screen).
    <aside className="sticky top-0 hidden h-dvh w-60 shrink-0 flex-col self-start border-r bg-sidebar text-sidebar-foreground md:flex">
      <div className="flex justify-center px-5 pt-5 pb-4">
        <Link href="/home" className="rounded-sm">
          <BrandLogo priority className="w-[184px]" sizes="184px" />
        </Link>
      </div>
      <nav aria-label="Main" className="flex-1 space-y-4 overflow-y-auto px-3 pb-4">
        {groups.map((group) => {
          const list = items.filter((i) => i.group === group)
          if (list.length === 0) return null
          return (
            <div key={group}>
              <div className="px-2 pb-1 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">{group}</div>
              <ul className="space-y-0.5">
                {list.map((item) => {
                  const Icon = ICONS[item.icon]
                  const active = pathname === item.href || pathname.startsWith(item.href + '/')
                  return (
                    <li key={item.href}>
                      <Link
                        href={item.href}
                        aria-current={active ? 'page' : undefined}
                        className={cn(
                          'flex items-center gap-2 rounded-md px-2 py-1.5 text-sm hover:bg-sidebar-accent',
                          active && 'bg-sidebar-accent font-medium text-sidebar-accent-foreground',
                        )}
                      >
                        <Icon className="size-4" aria-hidden="true" />
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
