import { describe, expect, it } from 'vitest'
import { parseChannelStatus, parseChannels, parseVideoInputChannels } from '@/lib/nvr/isapi'

const NS = 'xmlns="http://www.hikvision.com/ver20/XMLSchema"'

describe('ISAPI parsing', () => {
  it('reads which channels are online', () => {
    const xml = `<InputProxyChannelStatusList ${NS}>
      <InputProxyChannelStatus><id>1</id><online>true</online></InputProxyChannelStatus>
      <InputProxyChannelStatus><id>2</id><online>false</online></InputProxyChannelStatus>
      <InputProxyChannelStatus version="2.0"><id>3</id><online> TRUE </online></InputProxyChannelStatus>
    </InputProxyChannelStatusList>`
    expect([...parseChannelStatus(xml)]).toEqual([[1, true], [2, false], [3, true]])
  })
  it('gives an empty map for an answer that is not a status list', () => {
    expect(parseChannelStatus('this is not xml').size).toBe(0)
  })
  it('reads channel names and camera addresses', () => {
    const xml = `<InputProxyChannelList ${NS}>
      <InputProxyChannel version="2.0"><id>1</id><name>Entrance</name><sourceInputPortDescriptor><ipAddress>192.0.2.11</ipAddress></sourceInputPortDescriptor></InputProxyChannel>
      <InputProxyChannel><id>2</id><name>Cash &amp; wrap</name></InputProxyChannel>
    </InputProxyChannelList>`
    expect(parseChannels(xml)).toEqual([
      { channel: 1, name: 'Entrance', ip: '192.0.2.11' },
      { channel: 2, name: 'Cash & wrap', ip: null },
    ])
  })
  it('reads the older video input list', () => {
    const xml = `<VideoInputChannelList ${NS}><VideoInputChannel><id>4</id><name>Back door</name></VideoInputChannel></VideoInputChannelList>`
    expect(parseVideoInputChannels(xml)).toEqual([{ channel: 4, name: 'Back door', ip: null }])
  })
})
