import { describe, expect, it } from 'vitest'
import { capabilitiesFor, capabilitySummary, compareVersions, OPERATIONS, reachabilityOf, type MatrixRow } from '@/lib/wifi/inventory'

// P2-5c-2 brief item 4: what the Wi-Fi inventory shows about capabilities (from the documented matrix only; nothing lab-validated) and
// reachability (from monitoring). Synthetic rows.
const row = (o: Partial<MatrixRow>): MatrixRow => ({
  vendor: 'NETGEAR', model: 'WAX615', firmware_min: null, firmware_max: null, management_mode: 'standalone', operation: 'mac_acl', support: 'supported',
  source_ref: 'S1', notes: null, adapter_state: 'none', ...o,
})

describe('Wi-Fi inventory: capabilities from the documented matrix', () => {
  it('compares firmware versions number by number', () => {
    expect(compareVersions('10.5.1', '10.4.12')).toBe(1)
    expect(compareVersions('2.0', '2.0.0')).toBe(0)
    expect(compareVersions('1.9', '1.10')).toBe(-1)
  })

  it('lists every operation: documented rows for the vendor, model and mode, everything else unverified; names are matched without case', () => {
    const rows = capabilitiesFor({ vendor: 'netgear', model: 'wax615', firmware: '10.5.1', managementMode: 'Standalone' }, [
      row({ operation: 'mac_acl', support: 'supported', source_ref: 'S9' }),
      row({ operation: 'telnet', support: 'unsupported', source_ref: 'S19' }),
      row({ operation: 'radio', support: 'supported', management_mode: 'insight_cloud' }),
      row({ operation: 'ssh', model: 'WAX610' }),
    ])
    expect(rows.map((r) => r.operation)).toEqual(OPERATIONS.map(([op]) => op))
    expect(rows.find((r) => r.operation === 'mac_acl')).toMatchObject({ support: 'supported', source: 'S9', labValidated: false })
    expect(rows.find((r) => r.operation === 'telnet')).toMatchObject({ support: 'unsupported', source: 'S19' })
    expect(rows.find((r) => r.operation === 'radio')).toMatchObject({ support: 'unverified', source: null, notes: 'No documentation found for this model and mode.' })
    expect(rows.find((r) => r.operation === 'ssh')).toMatchObject({ support: 'unverified', source: null })
    expect(capabilitySummary({ vendor: 'NETGEAR', model: 'WAX615', managementMode: 'standalone' }, rows)).toBe(`1 documented (none tested here), 1 not supported, ${OPERATIONS.length - 2} unverified.`)
  })

  it('a firmware range applies only to the firmware inside it; the most specific matching row wins', () => {
    const matrix = [row({ operation: 'snmpv3', support: 'unverified' }), row({ operation: 'snmpv3', support: 'supported', firmware_min: '10.0', source_ref: 'S7' })]
    expect(capabilitiesFor({ vendor: 'NETGEAR', model: 'WAX615', firmware: '10.5.1', managementMode: 'standalone' }, matrix).find((r) => r.operation === 'snmpv3')).toMatchObject({ support: 'supported', source: 'S7' })
    expect(capabilitiesFor({ vendor: 'NETGEAR', model: 'WAX615', firmware: '9.8', managementMode: 'standalone' }, matrix).find((r) => r.operation === 'snmpv3')).toMatchObject({ support: 'unverified', source: 'S1' })
    expect(capabilitiesFor({ vendor: 'NETGEAR', model: 'WAX615', firmware: null, managementMode: 'standalone' }, matrix).find((r) => r.operation === 'snmpv3')).toMatchObject({ support: 'unverified' })
  })

  it('without vendor, model or management mode nothing is matched, and the summary says what to add', () => {
    expect(capabilitiesFor({ vendor: null, model: 'WAX615', firmware: null, managementMode: 'standalone' }, [row({})])).toEqual([])
    expect(capabilitiesFor({ vendor: 'NETGEAR', model: 'WAX615', firmware: null, managementMode: null }, [row({})])).toEqual([])
    expect(capabilitySummary({ vendor: null, model: null, managementMode: null }, [])).toBe('Add the vendor and exact model to see what the documentation says.')
    expect(capabilitySummary({ vendor: 'NETGEAR', model: 'WAX615', managementMode: null }, [])).toBe('Add the management mode (for example standalone) to see what the documentation says.')
  })

  it('a row marked lab-validated says so (none is today)', () => {
    const rows = capabilitiesFor({ vendor: 'NETGEAR', model: 'WAX615', firmware: '1', managementMode: 'standalone' }, [row({ adapter_state: 'lab_validated' })])
    expect(rows.find((r) => r.operation === 'mac_acl')?.labValidated).toBe(true)
  })
})

describe('Wi-Fi inventory: reachability from monitoring', () => {
  const now = new Date('2026-10-22T10:00:00Z')
  it('uses the monitoring words: reachable, not reachable, not checked lately (older than 20 minutes), not checked yet, monitoring off', () => {
    expect(reachabilityOf({ enabled: true, status: 'up', last_checked_at: '2026-10-22T09:55:00Z' }, now)).toBe('Reachable')
    expect(reachabilityOf({ enabled: true, status: 'down', last_checked_at: '2026-10-22T09:55:00Z' }, now)).toBe('Not reachable')
    expect(reachabilityOf({ enabled: true, status: 'up', last_checked_at: '2026-10-22T09:00:00Z' }, now)).toBe('Not checked lately')
    // As everywhere in monitoring: a "down" stays down however old the result is (statusLabel); only a live result goes stale.
    expect(reachabilityOf({ enabled: true, status: 'down', last_checked_at: '2026-10-22T09:00:00Z' }, now)).toBe('Not reachable')
    expect(reachabilityOf({ enabled: true, status: null, last_checked_at: null }, now)).toBe('Not checked yet')
    expect(reachabilityOf({ enabled: false, status: 'up', last_checked_at: '2026-10-22T09:55:00Z' }, now)).toBe('Monitoring off')
  })
})
