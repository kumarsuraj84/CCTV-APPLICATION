'use client'

import { useActionState, useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import { Button } from '@/components/ui/button'
import { PasswordInput } from '@/components/ui/password-input'
import { discoverRecorderAction, saveRecorderAction, setMonitoringAction, testConnectionAction, type AdminActionState } from '@/lib/actions/admin/locations'
import { Outcome, TextField } from './fields'

export type RecorderFormValues = {
  id: string; name: string; host: string | null; http_port: number; rtsp_port: number; username: string | null; expected_channels: number
  clock_offset_sec: number | null; password_saved: boolean
}

/**
 * Add an NVR to a location, or change one. The password is write-only: the field is always empty, an existing NVR says only whether
 * one is saved, and leaving it empty keeps it. The clock offset is how far the NVR's clock is behind the real time (ruling R13).
 */
export function RecorderForm({ locationId, recorder }: { locationId: string; recorder?: RecorderFormValues }) {
  const router = useRouter()
  const [state, action, pending] = useActionState<AdminActionState, FormData>(async (prev, f) => {
    const res = await saveRecorderAction(locationId, prev, f)
    if (res.ok && !recorder && res.id) router.push(`/admin/locations/${locationId}/nvrs/${res.id}`)
    return res
  }, {})
  const v = (k: string, d: string | number | null | undefined) => state.values?.[k] ?? (d === null || d === undefined ? '' : String(d))
  const p = recorder ? `nvr-${recorder.id}` : `nvr-new-${locationId}`
  return (
    <form action={action} className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3" autoComplete="off">
      <input type="hidden" name="id" value={recorder?.id ?? ''} />
      <TextField id={`${p}-name`} name="name" label="NVR name" required maxLength={200} defaultValue={v('name', recorder?.name)} placeholder="For example Ground floor" />
      <TextField id={`${p}-host`} name="host" label="NVR address" required defaultValue={v('host', recorder?.host)} placeholder="192.168.1.100" help="IP address or host name." />
      <TextField id={`${p}-http`} name="http_port" label="Web port" inputMode="numeric" defaultValue={v('http_port', recorder?.http_port ?? 80)} />
      <TextField id={`${p}-rtsp`} name="rtsp_port" label="Video port (RTSP)" inputMode="numeric" defaultValue={v('rtsp_port', recorder?.rtsp_port ?? 554)} />
      <TextField id={`${p}-user`} name="username" label="NVR user name" required defaultValue={v('username', recorder?.username)} autoComplete="off" help="A read-only (viewer) user is safest." />
      <div className="space-y-1.5">
        <label htmlFor={`${p}-password`} className="block text-sm font-medium">NVR password{!recorder && <span aria-hidden="true" className="text-destructive"> *</span>}</label>
        <PasswordInput id={`${p}-password`} name="password" autoComplete="new-password" required={!recorder} aria-describedby={`${p}-password-help`} className="h-10" />
        <p id={`${p}-password-help`} className="text-xs text-muted-foreground">
          {recorder ? (recorder.password_saved ? 'A password is saved. Leave empty to keep it.' : 'No password is saved yet.') : 'Kept in the vault; it is never shown again.'}
        </p>
      </div>
      <TextField id={`${p}-channels`} name="expected_channels" label="Number of cameras" inputMode="numeric" defaultValue={v('expected_channels', recorder?.expected_channels ?? 0)} help="Channels 1 to this number get a camera until “Find cameras” names them." />
      <TextField id={`${p}-offset`} name="clock_offset_sec" label="Clock offset (seconds)" inputMode="numeric" defaultValue={v('clock_offset_sec', recorder?.clock_offset_sec)} help="How far the NVR clock is behind the real time; a minus sign if it is ahead. Empty = the default." />
      <div className="space-y-2 sm:col-span-2 lg:col-span-3">
        <Button type="submit" disabled={pending}>{pending ? 'Saving…' : recorder ? 'Save NVR' : 'Add NVR'}</Button>
        <Outcome state={state} />
      </div>
    </form>
  )
}

/** Monitoring of one NVR switched off (nothing contacts it or its cameras) or on, always with a reason (audited). */
export function MonitoringSwitch({ recorderId, enabled, reason }: { recorderId: string; enabled: boolean; reason: string | null }) {
  const router = useRouter()
  const [text, setText] = useState('')
  const [state, setState] = useState<AdminActionState | null>(null)
  const [busy, start] = useTransition()
  const id = `mon-${recorderId}`
  const submit = () =>
    start(async () => {
      const res = await setMonitoringAction(recorderId, { enabled: !enabled, reason: text })
      setState(res)
      if (res.ok) {
        setText('')
        router.refresh()
      }
    })
  return (
    <div className="space-y-2">
      <p className="text-sm">
        {enabled ? 'Monitoring is on: the NVR and its cameras are checked, watched and played back.' : `Monitoring is switched off${reason ? ` (${reason})` : ''}: nothing contacts this NVR or its cameras.`}
      </p>
      <div className="grid gap-2 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-end">
        <TextField id={id} name="reason" label={enabled ? 'Reason for switching off' : 'Reason for switching on'} value={text} onChange={(e) => setText(e.target.value)} maxLength={500} />
        <Button type="button" variant={enabled ? 'destructive' : 'default'} className="h-10" disabled={busy} onClick={submit}>{busy ? 'Saving…' : enabled ? 'Switch monitoring off' : 'Switch monitoring on'}</Button>
      </div>
      <Outcome state={state} />
    </div>
  )
}

/** One read-only login test (a refused login makes the NVR wait before it is asked again). */
export function TestConnectionButton({ recorderId }: { recorderId: string }) {
  const [state, setState] = useState<AdminActionState | null>(null)
  const [busy, start] = useTransition()
  return (
    <div className="space-y-2">
      <Button type="button" variant="outline" disabled={busy} onClick={() => start(async () => setState(await testConnectionAction(recorderId)))}>{busy ? 'Testing…' : 'Test connection'}</Button>
      <Outcome state={state} />
    </div>
  )
}

/** "Find cameras" on this NVR: names and channels from the NVR; anything it cannot place goes to the reconciliation list. */
export function DiscoverNvrButton({ recorderId }: { recorderId: string }) {
  const router = useRouter()
  const [state, setState] = useState<AdminActionState | null>(null)
  const [busy, start] = useTransition()
  return (
    <div className="space-y-2">
      <Button type="button" variant="outline" disabled={busy} onClick={() => start(async () => {
        const res = await discoverRecorderAction(recorderId)
        setState(res)
        if (res.ok) router.refresh()
      })}>{busy ? 'Looking…' : 'Find cameras'}</Button>
      <Outcome state={state} />
    </div>
  )
}
