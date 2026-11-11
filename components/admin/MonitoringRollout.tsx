'use client'

import { useId, useState, useTransition } from 'react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Select } from '@/components/ui/select'
import { setMonitoringRolloutAction } from '@/lib/actions/admin/monitoring-rollout'
import type { RolloutOverview, RolloutScope } from '@/lib/inventory/monitoring-rollout'

// Final fix X (release 1 review C I-4; ruling NB-4): the monitoring rollout. One form: what (the organisation, a region, a cluster or a
// location), on or off, and a reason; the counts show where monitoring is on today. The server asks for a fresh sign-in.

const field = 'w-full rounded-md border border-input bg-background px-3 py-2 text-base sm:text-sm'

export function MonitoringRollout({ overview }: { overview: RolloutOverview }) {
  const id = useId()
  const [scope, setScope] = useState<RolloutScope>('location')
  const [target, setTarget] = useState('')
  const [enabled, setEnabled] = useState(true)
  const [reason, setReason] = useState('')
  const [pending, start] = useTransition()
  const options = scope === 'region' ? overview.regions : scope === 'cluster' ? overview.clusters : scope === 'location' ? overview.locations : []
  const chosen = options.find((o) => o.id === target)
  const count = scope === 'organization' ? overview.totals : chosen ?? null

  const submit = (e: React.FormEvent) => {
    e.preventDefault()
    start(async () => {
      try {
        const res = await setMonitoringRolloutAction({ scope, scopeId: scope === 'organization' ? null : target, enabled, reason })
        if (res.error) toast.error(res.error)
        else {
          toast.success(res.message ?? 'Done.')
          setReason('')
        }
      } catch {
        toast.error('Could not send the change. Check your connection and try again.')
      }
    })
  }

  return (
    <form onSubmit={submit} className="space-y-4 rounded-xl border bg-card p-4" aria-describedby={`${id}-help`}>
      <p id={`${id}-help`} className="text-sm text-muted-foreground">
        Switch monitoring on step by step: one location first, then its cluster, then the rest by region. NVRs never checked before are
        contacted a few at a time (10 per round at first). A switched-off NVR is contacted by nothing: no checks, no live video, no playback.
      </p>
      <div className="grid gap-3 sm:grid-cols-2">
        <label className="space-y-1 text-sm">
          <span className="font-medium">What</span>
          <Select value={scope} onChange={(e) => { setScope(e.target.value as RolloutScope); setTarget('') }}>
            <option value="location">One location</option>
            <option value="cluster">A cluster</option>
            <option value="region">A region</option>
            <option value="organization">Every NVR of the organisation</option>
          </Select>
        </label>
        {scope !== 'organization' && (
          <label className="space-y-1 text-sm">
            <span className="font-medium">{scope === 'location' ? 'Location' : scope === 'cluster' ? 'Cluster' : 'Region'}</span>
            <Select value={target} onChange={(e) => setTarget(e.target.value)} required>
              <option value="">Choose…</option>
              {options.map((o) => (
                <option key={o.id} value={o.id}>
                  {o.code} · {o.name} ({o.on} on, {o.off} off)
                </option>
              ))}
            </Select>
          </label>
        )}
      </div>
      <fieldset className="space-y-1 text-sm">
        <legend className="font-medium">Monitoring</legend>
        <div className="flex flex-wrap gap-4">
          <label className="flex items-center gap-2"><input type="radio" name={`${id}-on`} checked={enabled} onChange={() => setEnabled(true)} /> Switch on</label>
          <label className="flex items-center gap-2"><input type="radio" name={`${id}-on`} checked={!enabled} onChange={() => setEnabled(false)} /> Switch off</label>
        </div>
      </fieldset>
      <label className="block space-y-1 text-sm">
        <span className="font-medium">Reason</span>
        <input className={field} value={reason} onChange={(e) => setReason(e.target.value)} minLength={3} maxLength={500} required placeholder="For example: pilot at JCL" />
      </label>
      {count && (
        <p className="text-sm text-muted-foreground" role="status">
          Today: {count.on} NVRs on, {count.off} off{scope === 'organization' ? ' in the organisation' : ''}.
        </p>
      )}
      <Button type="submit" disabled={pending || (scope !== 'organization' && !target)}>
        {pending ? 'Saving…' : enabled ? 'Switch monitoring on' : 'Switch monitoring off'}
      </Button>
    </form>
  )
}
