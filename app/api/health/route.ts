import { cachedFor, readPublicHealth } from '@/lib/monitor/health'
import { createAdminClient } from '@/lib/supabase/admin'

export const dynamic = 'force-dynamic'

// The answer is kept for 2 seconds, so that anyone hammering this public address cannot make the database work harder than that.
const read = cachedFor(2000, () => readPublicHealth(createAdminClient))

// Public: says whether the app, the database and the worker are alive. No counts, names, addresses or error details.
export async function GET() {
  return Response.json(await read(), { headers: { 'Cache-Control': 'no-store' } })
}
