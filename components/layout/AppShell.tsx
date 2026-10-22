import Link from 'next/link'
import { LogOut } from 'lucide-react'
import { mobileNavFor, navFor, type Role } from '@/lib/nav'
import type { Capabilities } from '@/lib/auth/capabilities'
import { signOut } from '@/lib/actions/auth'
import { BRAND } from '@/lib/brand'
import { Button } from '@/components/ui/button'
import { BrandLogo } from './BrandLogo'
import { MobileNav } from './MobileNav'
import { NewVersionBanner } from './NewVersionBanner'
import { Sidebar } from './Sidebar'

// The role in words for the top bar. The same words as owner ruling P-1 ("Super administrator" for platform_owner). P2-3 is adding the
// shared ROLE_LABELS to lib/admin/roles.ts; once that is committed this map should be replaced by it (kept here so this commit stands alone).
const ROLE_WORDS: Record<Role, string> = {
  user: 'Viewer',
  operator: 'Operator',
  manager: 'Manager',
  admin: 'Administrator',
  platform_owner: 'Super administrator',
}

// The links follow the person's capabilities (P2-2; lib/nav.ts). Only plain item data goes to the client components.
// P3-0: the full logo heads the desktop sidebar; on a phone (no sidebar) the top bar shows the compact mark. The top bar names the
// person and their role in words. One light theme: no theme switch.
export function AppShell({ profile, children }: { profile: { full_name: string; role: Role; capabilities: Capabilities }; children: React.ReactNode }) {
  const viewer = { role: profile.role, capabilities: profile.capabilities }
  return (
    <div className="flex h-full min-h-screen">
      <Sidebar items={navFor(viewer)} />
      <div className="flex min-w-0 flex-1 flex-col">
        <NewVersionBanner />
        <header className="flex h-14 shrink-0 items-center gap-3 border-b bg-background px-4">
          <Link href="/home" className="flex min-w-0 items-center gap-2 rounded-sm md:hidden">
            <BrandLogo variant="mark" className="h-8" />
            <span className="hidden truncate text-sm font-semibold sm:inline" aria-hidden="true">{BRAND.name}</span>
          </Link>
          <div className="ml-auto flex min-w-0 items-center gap-3">
            <div className="flex min-w-0 flex-col items-end leading-tight">
              <span className="max-w-[11rem] truncate text-sm font-medium sm:max-w-[16rem]">{profile.full_name}</span>
              <span className="text-xs text-muted-foreground">{ROLE_WORDS[profile.role]}</span>
            </div>
            <form action={signOut}>
              <Button type="submit" variant="outline" size="sm">
                <LogOut aria-hidden="true" />
                Sign out
              </Button>
            </form>
          </div>
        </header>
        <main className="mx-auto w-full max-w-[100rem] flex-1 p-4 pb-20 md:p-6 md:pb-6">{children}</main>
      </div>
      <MobileNav items={mobileNavFor(viewer)} />
    </div>
  )
}
