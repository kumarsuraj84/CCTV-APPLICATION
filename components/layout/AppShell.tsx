import { mobileNavFor, navFor, type Role } from '@/lib/nav'
import type { Capabilities } from '@/lib/auth/capabilities'
import { signOut } from '@/lib/actions/auth'
import { Button } from '@/components/ui/button'
import { MobileNav } from './MobileNav'
import { NewVersionBanner } from './NewVersionBanner'
import { Sidebar } from './Sidebar'
import { ThemeSwitcher } from './ThemeSwitcher'

// The links follow the person's capabilities (P2-2; lib/nav.ts). Only plain item data goes to the client components.
export function AppShell({ profile, children }: { profile: { full_name: string; role: Role; capabilities: Capabilities }; children: React.ReactNode }) {
  const viewer = { role: profile.role, capabilities: profile.capabilities }
  return (
    <div className="flex h-full min-h-screen">
      <Sidebar items={navFor(viewer)} />
      <div className="flex min-w-0 flex-1 flex-col">
        <NewVersionBanner />
        <header className="flex items-center justify-end gap-2 border-b px-4 py-2">
          <span className="mr-2 text-sm text-muted-foreground">{profile.full_name}</span>
          <ThemeSwitcher />
          <form action={signOut}>
            <Button type="submit" variant="outline" size="sm">
              Sign out
            </Button>
          </form>
        </header>
        <main className="mx-auto w-full max-w-[100rem] flex-1 p-4 pb-20 md:p-6 md:pb-6">{children}</main>
      </div>
      <MobileNav items={mobileNavFor(viewer)} />
    </div>
  )
}
