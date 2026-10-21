export const dynamic = 'force-dynamic'

// Plan 1 only reports that the web app is up. Plan 2 adds the database and worker heartbeat.
export function GET() {
  return Response.json({ status: 'ok' })
}
