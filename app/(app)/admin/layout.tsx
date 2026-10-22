import { FreshAuthNotice } from '@/components/auth/FreshAuthNotice'
import { getCurrentProfile } from '@/lib/auth/profile'

// P3-1 review I-3: every change on the administration pages goes through the one fresh-sign-in guard (lib/auth/fresh.ts), so the
// notice that says whether changes are allowed now — with "Confirm it's you" in a new tab — is shown once, on all of them.
export default async function AdminLayout({ children }: { children: React.ReactNode }) {
  const profile = await getCurrentProfile()
  return (
    <>
      <FreshAuthNotice session={profile?.session ?? null} what="Changes on the administration pages" />
      {children}
    </>
  )
}
