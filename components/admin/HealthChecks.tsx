import { CircleAlert, CircleCheck, CircleHelp, CircleX } from 'lucide-react'
import type { CheckState, DetailedHealth } from '@/lib/ops/health'
import { formatDateTime } from '@/lib/time'
import { cn } from '@/lib/utils'

// P5.4: the Health page's list of checks (lib/ops/health.ts). Each state is a word and an icon, never colour alone.

const STATE: Record<CheckState, { word: string; className: string; Icon: typeof CircleCheck }> = {
  ok: { word: 'OK', className: 'bg-emerald-100 text-emerald-800 dark:bg-emerald-950 dark:text-emerald-300', Icon: CircleCheck },
  warning: { word: 'Needs attention', className: 'bg-[var(--warning-soft)] text-[var(--on-warning-soft)]', Icon: CircleAlert },
  failed: { word: 'Problem', className: 'bg-red-100 text-red-800 dark:bg-red-950 dark:text-red-300', Icon: CircleX },
  unknown: { word: 'Not known', className: 'bg-muted text-muted-foreground', Icon: CircleHelp },
}

export function HealthStateBadge({ state }: { state: CheckState }) {
  const s = STATE[state]
  return (
    <span className={cn('inline-flex items-center gap-1 whitespace-nowrap rounded-full px-2 py-0.5 text-xs font-medium', s.className)}>
      <s.Icon aria-hidden="true" className="size-3 shrink-0" />
      {s.word}
    </span>
  )
}

export function HealthChecks({ health }: { health: DetailedHealth }) {
  const problems = health.checks.filter((c) => c.state === 'failed').length
  const attention = health.checks.filter((c) => c.state === 'warning').length
  return (
    <div className="space-y-4">
      <section aria-labelledby="health-overall" className="flex flex-wrap items-center gap-x-3 gap-y-1 rounded-xl border bg-card p-4">
        <h2 id="health-overall" className="font-medium">Overall</h2>
        <HealthStateBadge state={health.status === 'ok' ? (attention > 0 ? 'warning' : 'ok') : 'failed'} />
        <span className="text-sm text-muted-foreground">
          {problems > 0 ? `${problems} problem${problems === 1 ? '' : 's'}` : 'No problem'}
          {attention > 0 ? `, ${attention} to look at` : ''} · checked {formatDateTime(health.checkedAt)} · release <span translate="no">{health.build}</span>
        </span>
      </section>
      <ul className="grid gap-3 md:grid-cols-2">
        {health.checks.map((c) => (
          <li key={c.key} className="space-y-2 rounded-xl border bg-card p-4" aria-labelledby={`health-${c.key}`}>
            <div className="flex flex-wrap items-center gap-2">
              <h3 id={`health-${c.key}`} className="font-medium">{c.label}</h3>
              <HealthStateBadge state={c.state} />
            </div>
            <p className={cn('text-sm', c.state === 'failed' ? 'text-destructive' : 'text-foreground')}>{c.summary}</p>
            {c.facts.length > 0 && (
              <dl className="grid grid-cols-[minmax(0,1fr)_minmax(0,1fr)] gap-x-4 gap-y-1 text-sm">
                {c.facts.map(([k, v]) => (
                  <div key={k} className="contents">
                    <dt className="text-muted-foreground">{k}</dt>
                    <dd className="break-words">{v}</dd>
                  </div>
                ))}
              </dl>
            )}
          </li>
        ))}
      </ul>
    </div>
  )
}
