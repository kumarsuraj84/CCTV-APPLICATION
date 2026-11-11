import { describe, expect, it } from 'vitest'
import { parseLocationsCsv } from '@/lib/import/locations-csv'
import { planImport, type ImportSnapshot } from '@/lib/import/locations-plan'

// Final fix X (release 1 review C I-4; ruling NB-4): in production a newly IMPORTED NVR starts with monitoring switched off unless the
// file says "yes", so a first import of the estate never makes the worker contact 216 NVRs; development keeps the old default (on).

const empty = (): ImportSnapshot => ({ locations: [], recorders: [], activeCameras: [], channelsEverMapped: {}, regions: [], clusters: [], archivedCodes: [], looseCameras: [] })
const HEAD = 'name,city,zone,ip,port,http_port,user,password,channels,monitoring'
const file = (monitoring: string) => parseLocationsCsv(`${HEAD}\nJCL,Jhansi,UP,192.0.2.10,554,80,viewer,Pw-JCL-1,4,${monitoring}\n`)
const first = (p: ReturnType<typeof planImport>) => ({ view: p.preview.locations[0].recorders[0].monitoring, apply: p.apply.locations[0].recorders[0].monitoring })

describe('the monitoring of a newly imported NVR', () => {
  it('production: off when the file says nothing, on only when it says yes, off when it says no', () => {
    const opts = { skipBadRows: false, newRecordersMonitored: false }
    expect(first(planImport(file(''), empty(), opts))).toEqual({ view: 'off', apply: false })
    expect(first(planImport(file('yes'), empty(), opts))).toEqual({ view: 'on', apply: true })
    expect(first(planImport(file('no'), empty(), opts))).toEqual({ view: 'off', apply: false })
  })

  it('development (or not said): on unless the file says no, as before', () => {
    expect(first(planImport(file(''), empty(), { skipBadRows: false }))).toEqual({ view: 'on', apply: true })
    expect(first(planImport(file('no'), empty(), { skipBadRows: false, newRecordersMonitored: true }))).toEqual({ view: 'off', apply: false })
  })
})
