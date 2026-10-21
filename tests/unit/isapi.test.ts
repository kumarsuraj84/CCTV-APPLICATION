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

describe('ISAPI parsing: channel numbers', () => {
  const status = (ids: string[]) => `<InputProxyChannelStatusList ${NS}>${ids.map((i) => `<InputProxyChannelStatus><id>${i}</id><online>true</online></InputProxyChannelStatus>`).join('')}</InputProxyChannelStatusList>`
  const list = (ids: string[]) => `<InputProxyChannelList ${NS}>${ids.map((i) => `<InputProxyChannel><id>${i}</id><name>n${i}</name></InputProxyChannel>`).join('')}</InputProxyChannelList>`

  it('keeps only whole numbers from 1 to 4096', () => {
    const ids = ['0', '1', '4096', '4097', '-1', '1.5', '1e3', 'abc', '', '12345', '99999999999']
    expect([...parseChannelStatus(status(ids)).keys()]).toEqual([1, 4096])
    expect(parseChannels(list(ids)).map((c) => c.channel)).toEqual([1, 4096])
    expect(parseVideoInputChannels(list(ids).replace(/InputProxyChannel/g, 'VideoInputChannel')).map((c) => c.channel)).toEqual([1, 4096])
  })
  it('keeps the first entry when a channel is listed twice', () => {
    const xml = `<InputProxyChannelStatusList ${NS}>
      <InputProxyChannelStatus><id>2</id><online>true</online></InputProxyChannelStatus>
      <InputProxyChannelStatus><id>2</id><online>false</online></InputProxyChannelStatus>
    </InputProxyChannelStatusList>`
    expect([...parseChannelStatus(xml)]).toEqual([[2, true]])
    const channels = `<InputProxyChannelList ${NS}>
      <InputProxyChannel><id>5</id><name>First</name></InputProxyChannel>
      <InputProxyChannel><id>5</id><name>Second</name></InputProxyChannel>
    </InputProxyChannelList>`
    expect(parseChannels(channels)).toEqual([{ channel: 5, name: 'First', ip: null }])
    const older = `<VideoInputChannelList ${NS}><VideoInputChannel><id>5</id><name>First</name></VideoInputChannel><VideoInputChannel><id>5</id><name>Second</name></VideoInputChannel></VideoInputChannelList>`
    expect(parseVideoInputChannels(older)).toEqual([{ channel: 5, name: 'First', ip: null }])
  })
})

describe('ISAPI parsing: names and addresses', () => {
  const one = (inner: string) => parseChannels(`<InputProxyChannelList ${NS}><InputProxyChannel><id>3</id>${inner}</InputProxyChannel></InputProxyChannelList>`)[0]

  it('trims names and caps them at 80 characters', () => {
    expect(one('<name>  Front door \n</name>').name).toBe('Front door')
    expect(one(`<name>${'x'.repeat(200)}</name>`).name).toBe('x'.repeat(80))
    expect(one(`<name>${'é'.repeat(200)}</name>`).name).toBe('é'.repeat(80))
  })
  it('names a camera by its number when the name is empty or missing', () => {
    expect(one('<name>   </name>').name).toBe('Camera 3')
    expect(one('<name></name>').name).toBe('Camera 3')
    expect(one('').name).toBe('Camera 3')
  })
  it('keeps an address only when it is an IP address', () => {
    expect(one('<name>a</name><sourceInputPortDescriptor><ipAddress>192.0.2.11</ipAddress></sourceInputPortDescriptor>').ip).toBe('192.0.2.11')
    expect(one('<name>a</name><sourceInputPortDescriptor><ipAddress>2001:db8::1</ipAddress></sourceInputPortDescriptor>').ip).toBe('2001:db8::1')
    expect(one('<name>a</name><sourceInputPortDescriptor><ipAddress>cam.example.com</ipAddress></sourceInputPortDescriptor>').ip).toBeNull()
    expect(one('<name>a</name><sourceInputPortDescriptor><ipAddress>999.1.1.1</ipAddress></sourceInputPortDescriptor>').ip).toBeNull()
    expect(one('<name>a</name><sourceInputPortDescriptor><ipAddress>1.2.3.4; rm -rf</ipAddress></sourceInputPortDescriptor>').ip).toBeNull()
    expect(one('<name>a</name><sourceInputPortDescriptor><ipAddress></ipAddress></sourceInputPortDescriptor>').ip).toBeNull()
  })
  it('decodes named and numeric entities once and unwraps CDATA', () => {
    expect(one('<name>It&#39;s &#x27;ok&#X27; &lt;b&gt; &quot;q&quot; &apos;a&apos;</name>').name).toBe(`It's 'ok' <b> "q" 'a'`)
    expect(one('<name>&amp;lt;</name>').name).toBe('&lt;')
    expect(one('<name>&#0; &#xD800; &#x110000; &bogus;</name>').name).toBe('&#0; &#xD800; &#x110000; &bogus;')
    expect(one('<name><![CDATA[Cash & <wrap> &amp;]]></name>').name).toBe('Cash & <wrap> &amp;')
    expect(one('<name>A &amp; <![CDATA[B & C]]> &amp; D</name>').name).toBe('A & B & C & D')
    expect(one('<name><![CDATA[never closed</name>').name).toBe('<![CDATA[never closed')
  })
  it('reads tags in any letter case and ignores longer tag names that start the same', () => {
    const xml = `<inputproxychannellist><INPUTPROXYCHANNEL><ID>9</ID><NAME>Upper</NAME></INPUTPROXYCHANNEL></inputproxychannellist>`
    expect(parseChannels(xml)).toEqual([{ channel: 9, name: 'Upper', ip: null }])
  })
})

describe('ISAPI parsing: hostile input', () => {
  const fast = (f: () => unknown) => {
    const t = Date.now()
    f()
    return Date.now() - t
  }
  const MB = 1024 * 1024
  const cases: [string, string][] = [
    ['unclosed status tags', '<InputProxyChannelStatus>'.repeat(Math.ceil(MB / 25))],
    ['unclosed status tags with attributes and no end', '<InputProxyChannelStatus version="2.0" '.repeat(Math.ceil(MB / 37))],
    ['unclosed channel tags', '<InputProxyChannel>'.repeat(Math.ceil(MB / 19))],
    ['unclosed video input tags', '<VideoInputChannel>'.repeat(Math.ceil(MB / 19))],
    ['one element full of unclosed inner tags', `<InputProxyChannelStatus>${'<id>'.repeat(MB / 4)}</InputProxyChannelStatus>`],
    ['one channel full of unclosed names and CDATA', `<InputProxyChannel><id>1</id>${'<name><![CDATA['.repeat(MB / 15)}</InputProxyChannel>`],
    ['many tiny closed elements', '<InputProxyChannelStatus><id>1</id><online>true</online></InputProxyChannelStatus>'.repeat(Math.ceil(MB / 80))],
  ]
  it.each(cases)('is fast on a megabyte of %s', (_label, xml) => {
    expect(xml.length).toBeGreaterThanOrEqual(MB - 100)
    expect(fast(() => parseChannelStatus(xml))).toBeLessThan(500)
    expect(fast(() => parseChannels(xml))).toBeLessThan(500)
    expect(fast(() => parseVideoInputChannels(xml))).toBeLessThan(500)
  })
  it('still returns nothing for unclosed tags', () => {
    expect(parseChannelStatus('<InputProxyChannelStatus>'.repeat(1000)).size).toBe(0)
    expect(parseChannels('<InputProxyChannel><id>1</id>'.repeat(1000))).toEqual([])
  })
})
