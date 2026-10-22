import { AppShell } from '@/components/layout/AppShell'
import { InputReporter } from '@/components/layout/InputReporter'
import { requireProfile } from '@/lib/auth/profile'

export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const profile = await requireProfile()
  return (
    <AppShell profile={{ full_name: profile.full_name || profile.email, role: profile.role, capabilities: profile.capabilities }}>
      {/* P4-L1 review I-2: the last real input, for the idle limit (background requests do not count as activity). */}
      <InputReporter />
      {children}
    </AppShell>
  )
}
