'use client'

import { useActionState } from 'react'
import { Button } from '@/components/ui/button'
import { saveNetworkAction, type AdminActionState } from '@/lib/actions/admin/locations'
import { AreaField, Outcome, TextField } from './fields'

export type NetworkValues = {
  management_cidr: string; gateway: string | null; dns: string[]; management_vlan: number | null; vlan_map: Record<string, number>
  discovery_ranges: string[]; sdwan_context: string | null
}

/**
 * A location's network definition (decision W-1): its management network, gateway, DNS servers, management VLAN, the VLANs for staff,
 * guests and devices, and the ranges discovery may look at (inside the management network). Checked here, by the server and by the
 * database; an address outside the network is flagged, never silently allowed. Emptying the management network removes it.
 */
export function NetworkForm({ locationId, definition }: { locationId: string; definition: NetworkValues | null }) {
  const [state, action, pending] = useActionState<AdminActionState, FormData>(saveNetworkAction.bind(null, locationId), {})
  const d = definition
  const v = (k: string, fallback: string) => state.values?.[k] ?? fallback
  const vlan = (k: string) => (d?.vlan_map?.[k] !== undefined ? String(d.vlan_map[k]) : '')
  const p = `net-${locationId}`
  return (
    <form action={action} className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
      <TextField id={`${p}-cidr`} name="management_cidr" label="Management network" defaultValue={v('management_cidr', d?.management_cidr ?? '')} placeholder="192.168.10.0/24" help="Leave empty to remove the definition." />
      <TextField id={`${p}-gw`} name="gateway" label="Gateway" defaultValue={v('gateway', d?.gateway ?? '')} placeholder="192.168.10.1" />
      <TextField id={`${p}-dns`} name="dns" label="DNS servers" defaultValue={v('dns', (d?.dns ?? []).join(', '))} placeholder="10.0.0.53, 10.0.0.54" help="Separate with commas." />
      <TextField id={`${p}-mvlan`} name="management_vlan" label="Management VLAN" inputMode="numeric" defaultValue={v('management_vlan', d?.management_vlan != null ? String(d.management_vlan) : '')} help="1 to 4094, optional." />
      <TextField id={`${p}-vstaff`} name="vlan_staff" label="Staff VLAN" inputMode="numeric" defaultValue={v('vlan_staff', vlan('staff'))} />
      <TextField id={`${p}-vguest`} name="vlan_guest" label="Guest VLAN" inputMode="numeric" defaultValue={v('vlan_guest', vlan('guest'))} />
      <TextField id={`${p}-vdev`} name="vlan_device" label="Device VLAN" inputMode="numeric" defaultValue={v('vlan_device', vlan('device'))} />
      <TextField id={`${p}-voth`} name="vlan_other" label="Other VLAN" inputMode="numeric" defaultValue={v('vlan_other', vlan('other'))} />
      <TextField id={`${p}-ranges`} name="discovery_ranges" label="Discovery ranges" defaultValue={v('discovery_ranges', (d?.discovery_ranges ?? []).join(', '))} placeholder="192.168.10.0/25" help="Inside the management network; separate with commas." />
      <AreaField id={`${p}-sdwan`} name="sdwan_context" label="SD-WAN notes" className="sm:col-span-2 lg:col-span-3" defaultValue={v('sdwan_context', d?.sdwan_context ?? '')} maxLength={1000} help="For example the link type or the provider’s circuit name. Optional." />
      <div className="space-y-2 sm:col-span-2 lg:col-span-3">
        <Button type="submit" disabled={pending}>{pending ? 'Saving…' : 'Save network definition'}</Button>
        <Outcome state={state} />
      </div>
    </form>
  )
}
