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
})
