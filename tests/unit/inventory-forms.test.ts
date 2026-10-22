import { describe, expect, it } from 'vitest'
import {
  ASSET_TYPES, displayName, isCidr, isHostOrIp, LOCATION_KINDS, LOCATION_KIND_LABELS, locationTitle, mergeSentence, normaliseCode, parseChannel, parseClockOffset, parseList,
  parseVlan,
} from '@/lib/inventory/forms'

// P2-5c-1: the small pure rules of the administration forms (the services use them; the database checks the same things again).
describe('administration form rules', () => {
  it('codes are upper case letters, numbers and dashes (1 to 50); anything else is refused', () => {
    expect(normaliseCode(' east-1 ')).toBe('EAST-1')
    expect(normaliseCode('jcl')).toBe('JCL')
    expect(normaliseCode('')).toBeNull()
    expect(normaliseCode('a b')).toBeNull()
    expect(normaliseCode('x'.repeat(51))).toBeNull()
    expect(normaliseCode('-LEAD')).toBeNull()
  })

  it('the display name of a location is "CODE - City" (ruling R-1 amendment), or the code alone', () => {
    expect(displayName('JCL', 'Jhansi')).toBe('JCL - Jhansi')
    expect(displayName('JCL', '  ')).toBe('JCL')
  })

  it('location kinds in plain words', () => {
    expect(LOCATION_KINDS).toEqual(['store', 'head_office', 'dc', 'warehouse', 'other'])
    expect(LOCATION_KIND_LABELS).toEqual({ store: 'Store', head_office: 'Head office', dc: 'Distribution centre', warehouse: 'Warehouse', other: 'Other' })
  })

  it('clock offset in whole seconds from -86400 to 86400; empty means "use the default"', () => {
    expect(parseClockOffset('')).toEqual({ ok: true, value: null })
    expect(parseClockOffset(' 120 ')).toEqual({ ok: true, value: 120 })
    expect(parseClockOffset('-30')).toEqual({ ok: true, value: -30 })
    expect(parseClockOffset('1.5').ok).toBe(false)
    expect(parseClockOffset('86401').ok).toBe(false)
    expect(parseClockOffset('ten').ok).toBe(false)
  })

  it('channels are whole numbers from 1 to 999', () => {
    expect(parseChannel('4')).toBe(4)
    expect(parseChannel(7)).toBe(7)
    expect(parseChannel('0')).toBeNull()
    expect(parseChannel('1000')).toBeNull()
    expect(parseChannel('2.5')).toBeNull()
  })

  it('network fields: lists split on commas, spaces or new lines; CIDR and VLAN checks', () => {
    expect(parseList('10.0.0.53, 10.0.0.54\n10.0.0.55')).toEqual(['10.0.0.53', '10.0.0.54', '10.0.0.55'])
    expect(parseList('  ')).toEqual([])
    expect(isCidr('10.20.0.0/24')).toBe(true)
    expect(isCidr('10.20.0.0')).toBe(false)
    expect(isCidr('10.20.0.0/33')).toBe(false)
    expect(isCidr('nonsense')).toBe(false)
    expect(parseVlan('')).toEqual({ ok: true, value: null })
    expect(parseVlan('20')).toEqual({ ok: true, value: 20 })
    expect(parseVlan('5000').ok).toBe(false)
    expect(parseVlan('0').ok).toBe(false)
  })

  it('endpoint hosts are IP addresses or host names', () => {
    expect(isHostOrIp('10.41.0.5')).toBe(true)
    expect(isHostOrIp('switch-01.store.local')).toBe(true)
    expect(isHostOrIp('bad host!')).toBe(false)
    expect(isHostOrIp('')).toBe(false)
  })

  it('review I-5 / M-3: the merge confirmation names both cameras, the duplicate\'s place and who loses access', () => {
    expect(mergeSentence({ keepName: 'Cash office', duplicateName: 'Cash office (new)', duplicatePlace: 'JCL · First floor, channel 2', duplicateLinked: true, peopleLosing: 2 })).toBe(
      '“Cash office” keeps its identity, access, groups and history and takes over the NVR channel of “Cash office (new)” (JCL · First floor, channel 2), which is archived. 2 people have access to “Cash office (new)” only through a grant on it; that access ends.',
    )
    expect(mergeSentence({ keepName: 'A', duplicateName: 'B', duplicatePlace: 'JCL · not linked', duplicateLinked: false, peopleLosing: 0 })).toBe(
      '“A” keeps its identity, access, groups and history; “B” (JCL · not linked) is archived. Nobody loses access through a grant on “B”.',
    )
  })

  it('review M-12: a location title does not repeat its code', () => {
    expect(locationTitle('PTN1', 'PTN1 - Patna')).toBe('PTN1 - Patna')
    expect(locationTitle('HO-PAT', 'Head office, Patna')).toBe('HO-PAT · Head office, Patna')
  })

  it('asset types are the database enum without the NVR (an NVR is added on its location)', () => {
    expect(ASSET_TYPES).not.toContain('nvr')
    expect(ASSET_TYPES).toEqual(expect.arrayContaining(['server', 'attendance', 'footfall', 'other', 'sdwan_edge', 'switch', 'access_point', 'router', 'ups', 'printer', 'desktop', 'laptop']))
  })
})
