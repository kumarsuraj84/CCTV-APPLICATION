import { describe, expect, it } from 'vitest'
import { loadMonitorConfig } from '@/lib/monitor/config'

describe('loadMonitorConfig', () => {
  it('has the spec defaults', () => {
    expect(loadMonitorConfig({})).toMatchObject({ deviceCheckSec: 60, cameraCheckSec: 300, pollSec: 5, failThreshold: 2 })
  })
  it('reads numbers from the environment and ignores nonsense', () => {
    const c = loadMonitorConfig({ DEVICE_CHECK_SEC: '30', CAMERA_CHECK_SEC: 'abc', FAIL_THRESHOLD: '0' })
    expect(c.deviceCheckSec).toBe(30)
    expect(c.cameraCheckSec).toBe(300)
    expect(c.failThreshold).toBe(2)
  })
  it('never goes below a safe minimum', () => {
    expect(loadMonitorConfig({ DEVICE_CHECK_SEC: '1' }).deviceCheckSec).toBe(10)
  })
  it('treats an empty setting as not set, not as zero', () => {
    const c = loadMonitorConfig({ DEVICE_CHECK_SEC: '', CAMERA_CHECK_SEC: '  ', FAIL_THRESHOLD: '' })
    expect(c).toMatchObject({ deviceCheckSec: 60, cameraCheckSec: 300, failThreshold: 2 })
  })
  it('caps the intervals at one day and the failure threshold at 10, clamping rather than falling back', () => {
    const c = loadMonitorConfig({ DEVICE_CHECK_SEC: '999999999', CAMERA_CHECK_SEC: '86401', FAIL_THRESHOLD: '500' })
    expect(c).toMatchObject({ deviceCheckSec: 86400, cameraCheckSec: 86400, failThreshold: 10 })
  })
  it('accepts the limits themselves', () => {
    expect(loadMonitorConfig({ DEVICE_CHECK_SEC: '86400', CAMERA_CHECK_SEC: '10', FAIL_THRESHOLD: '10' })).toMatchObject({ deviceCheckSec: 86400, cameraCheckSec: 10, failThreshold: 10 })
    expect(loadMonitorConfig({ FAIL_THRESHOLD: '1' }).failThreshold).toBe(1)
  })
  it('treats a negative or zero threshold as nonsense (the default), and a fraction as nonsense too', () => {
    expect(loadMonitorConfig({ FAIL_THRESHOLD: '-3' }).failThreshold).toBe(2)
    expect(loadMonitorConfig({ FAIL_THRESHOLD: '2.5' }).failThreshold).toBe(2)
  })
})
