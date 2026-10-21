import { requireProfile } from '@/lib/auth/profile'

export const metadata = { title: 'Home' }

export default async function HomePage() {
  const profile = await requireProfile()
  return <h1 className="text-xl font-semibold">Welcome, {profile.full_name || profile.email}</h1>
}
