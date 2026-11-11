import Link from 'next/link'
import { LogOut, ShieldCheck } from 'lucide-react'
import { mobileNavFor, moreNavFor, navFor, type Role } from '@/lib/nav'
import type { Capabilities } from '@/lib/auth/capabilities'
import { signOut } from '@/lib/actions/auth'
import { ROLE_LABELS } from '@/lib/admin/roles'
import { BRAND } from '@/lib/brand'
import { Button } from '@/components/ui/button'
import { BrandLogo } from './BrandLogo'
import { MobileNav } from './MobileNav'
import { NewVersionBanner } from './NewVersionBanner'
import { Sidebar } from './Sidebar'

// The links follow the person's capabilities (P2-2; lib/nav.ts). Only plain item data goes to the client components.
// P3-0: the full logo heads the desktop sidebar; on a phone (no sidebar) the top bar shows the compact mark and the bottom bar carries
// the main pages. The top bar names the person and their role in words (P3-1: the shared ROLE_LABELS, "Super administrator" for
// platform_owner), links to their Security page (two-step sign-in, signing out everywhere) and signs out. One light theme.
export function AppShell({ profile, children }: { profile: { full_name: string; role: Role; capabilities: Capabilities }; children: React.ReactNode }) {
  const viewer = { role: profile.role, capabilities: profile.capabilities }
  return (
    // P3-1: grows with the page (not fixed to one screen), so the sticky sidebar stays in view down the whole page.
    <div className="flex min-h-screen">
      <a href="#main" className="sr-only z-50 rounded-md bg-background px-3 py-2 text-sm font-medium focus:not-sr-only focus:fixed focus:top-2 focus:left-2">Skip to the page</a>
      <Sidebar items={navFor(viewer)} />
      <div className="flex min-w-0 flex-1 flex-col">
        <NewVersionBanner />
        <header className="flex h-14 shrink-0 items-center gap-3 border-b bg-background px-4">
          <Link href="/home" className="flex min-w-0 items-center gap-2 rounded-sm md:hidden">
            <BrandLogo variant="mark" className="h-8" />
            <span className="hidden truncate text-sm font-semibold sm:inline" aria-hidden="true">{BRAND.name}</span>
          </Link>
          <div className="ml-auto flex min-w-0 items-center gap-2 sm:gap-3">
            <div className="flex min-w-0 flex-col items-end leading-tight">
              <span className="max-w-[9rem] truncate text-sm font-medium sm:max-w-[16rem]" translate="no">{profile.full_name}</span>
              <span className="text-xs text-muted-foreground">{ROLE_LABELS[profile.role]}</span>
            </div>
            <Link
              href="/account/security"
              className="inline-flex h-8 items-center gap-1.5 rounded-md border px-2.5 text-sm font-medium hover:bg-muted focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--ring)]"
            >
              <ShieldCheck aria-hidden="true" className="size-4" />
              <span className="sr-only sm:not-sr-only">Security</span>
            </Link>
            <form action={signOut}>
              <Button type="submit" variant="outline" size="sm">
                <LogOut aria-hidden="true" />
                <span className="sr-only sm:not-sr-only">Sign out</span>
              </Button>
            </form>
          </div>
        </header>
        <main id="main" tabIndex={-1} className="mx-auto w-full max-w-[100rem] flex-1 p-4 pb-20 outline-none md:p-6 md:pb-6">{children}</main>
      </div>
      <MobileNav items={mobileNavFor(viewer)} more={moreNavFor(viewer)} />
    </div>
  )
}
