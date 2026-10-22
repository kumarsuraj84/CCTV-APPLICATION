import { AppShell } from '@/components/layout/AppShell'
import { requireProfile } from '@/lib/auth/profile'

export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const profile = await requireProfile()
  return <AppShell profile={{ full_name: profile.full_name || profile.email, role: profile.role, capabilities: profile.capabilities }}>{children}</AppShell>
}
