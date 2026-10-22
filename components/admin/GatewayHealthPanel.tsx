import { StatusBadge } from '@/components/monitor/StatusBadge'
import type { GatewayHealthView } from '@/lib/streams/gateway-health'

// P2-4 brief item 3: the video gateway on the Monitoring page — how many videos are open, how old its last access check is, and a plain
// warning when it cannot check access (open video is then closed after the fail-closed time) or does not answer at all.

const ago = (sec: number | null) => (sec === null ? 'Not yet' : sec < 120 ? `${sec} seconds ago` : `${Math.round(sec / 60)} minutes ago`)

export function GatewayHealthPanel({ gateway, orgOpen }: { gateway: GatewayHealthView; orgOpen: number | null }) {
  const h = gateway.ok ? gateway.health : null
  const fine = h !== null && h.registry === 'ok'
  return (
    <section className="space-y-3 rounded-xl border bg-card p-4" aria-labelledby="gateway-health-title">
      <div className="flex flex-wrap items-center gap-2">
        <h2 id="gateway-health-title" className="font-medium">Video gateway</h2>
        <StatusBadge status={fine ? 'up' : 'down'} />
        <span className="text-sm text-muted-foreground">{h === null ? 'Not answering' : fine ? 'Checking access' : 'Cannot check access'}</span>
      </div>
      {h === null ? (
        <p className="text-sm text-destructive">
          The video gateway is not answering. Live video and playback do not work until it runs. Start it with <code className="font-mono">npm run gateway</code> on the server.
        </p>
      ) : (
        <>
          <dl className="grid gap-x-6 gap-y-1 text-sm sm:grid-cols-2">
            <dt className="text-muted-foreground">Open videos</dt>
            <dd>{h.openSessions}</dd>
            <dt className="text-muted-foreground">In your organisation</dt>
            <dd>{orgOpen === null ? 'Could not be read' : orgOpen}</dd>
            <dt className="text-muted-foreground">Last access check</dt>
            <dd>{ago(h.lastValidationAgeSec)}</dd>
          </dl>
          <p className="text-sm text-muted-foreground">
            Open video is checked every {h.validateEverySec} seconds. When someone loses access, their open video stops within a minute.
          </p>
          {!fine && (
            <p className="text-sm text-destructive">
              The gateway cannot check access right now. Open video is closed {h.failClosedAfterSec} seconds after the last successful check.
            </p>
          )}
        </>
      )}
    </section>
  )
}
