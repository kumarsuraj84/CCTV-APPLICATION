import { getCurrentProfile } from '@/lib/auth/profile'
import { mayReadDetailedHealth } from '@/lib/ops/access'
import { readDetailedHealth } from '@/lib/ops/health-server'

export const dynamic = 'force-dynamic'

// P5.4 brief item 3, the AUTHENTICATED detailed variant: every check of lib/ops/health.ts (database, Vault, gateway, worker lease and
// heartbeat, clocks, migration level, free disk, media-session clean-up) for a super administrator who has finished signing in. Anyone
// else gets the same answer as for an address that does not exist, and nothing is gathered for them. Reads only.
export async function GET() {
  const headers = { 'Cache-Control': 'no-store' }
  if (!mayReadDetailedHealth(await getCurrentProfile())) return Response.json({ error: 'Not found.' }, { status: 404, headers })
  return Response.json(await readDetailedHealth(), { headers })
}
