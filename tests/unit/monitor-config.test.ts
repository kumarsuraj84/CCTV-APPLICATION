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
  it('reads the NVR login back-off, 15 minutes by default, kept between a minute and a day', () => {
    expect(loadMonitorConfig({}).nvrLoginBackoffSec).toBe(900)
    expect(loadMonitorConfig({ NVR_LOGIN_BACKOFF_SEC: '120' }).nvrLoginBackoffSec).toBe(120)
    expect(loadMonitorConfig({ NVR_LOGIN_BACKOFF_SEC: '5' }).nvrLoginBackoffSec).toBe(60)
    expect(loadMonitorConfig({ NVR_LOGIN_BACKOFF_SEC: '9999999' }).nvrLoginBackoffSec).toBe(86400)
    expect(loadMonitorConfig({ NVR_LOGIN_BACKOFF_SEC: 'soon' }).nvrLoginBackoffSec).toBe(900)
  })
  // Final fix X (release 1 review C, "safe defaults at 216 NVRs"; ruling NB-5): the politeness settings.
  it('the escalating back-off: at most 6 hours by default, never below the first window, at most a day', () => {
    expect(loadMonitorConfig({}).nvrLoginBackoffMaxSec).toBe(21600)
    expect(loadMonitorConfig({ NVR_LOGIN_BACKOFF_MAX_SEC: '3600' }).nvrLoginBackoffMaxSec).toBe(3600)
    expect(loadMonitorConfig({ NVR_LOGIN_BACKOFF_SEC: '1800', NVR_LOGIN_BACKOFF_MAX_SEC: '60' }).nvrLoginBackoffMaxSec).toBe(1800)
    expect(loadMonitorConfig({ NVR_LOGIN_BACKOFF_MAX_SEC: '999999' }).nvrLoginBackoffMaxSec).toBe(86400)
  })
  it('an NVR is called down after 3 failed reachability checks in a row (SD-WAN blips, M-6), cameras after 2', () => {
    expect(loadMonitorConfig({})).toMatchObject({ failThreshold: 2, recorderFailThreshold: 3 })
    expect(loadMonitorConfig({ RECORDER_FAIL_THRESHOLD: '5' }).recorderFailThreshold).toBe(5)
    expect(loadMonitorConfig({ RECORDER_FAIL_THRESHOLD: '0' }).recorderFailThreshold).toBe(3)
    expect(loadMonitorConfig({ RECORDER_FAIL_THRESHOLD: '40' }).recorderFailThreshold).toBe(10)
  })
  it('the staggered start: at most 10 never-proven NVRs per camera round by default (1 to 500)', () => {
    expect(loadMonitorConfig({}).newRecordersPerRound).toBe(10)
    expect(loadMonitorConfig({ MONITOR_NEW_RECORDERS_PER_ROUND: '25' }).newRecordersPerRound).toBe(25)
    expect(loadMonitorConfig({ MONITOR_NEW_RECORDERS_PER_ROUND: '0' }).newRecordersPerRound).toBe(1)
    expect(loadMonitorConfig({ MONITOR_NEW_RECORDERS_PER_ROUND: '5000' }).newRecordersPerRound).toBe(500)
  })
  it('keeps the reviewed estate defaults: 10 NVRs at once, 4 video checks per NVR, 3/8 s timeouts', () => {
    expect(loadMonitorConfig({})).toMatchObject({ recorderConcurrency: 10, rtspPerRecorder: 4, tcpTimeoutMs: 3000, nvrTimeoutMs: 8000, deviceCheckSec: 60, cameraCheckSec: 300 })
  })
  it('treats a negative or zero threshold as nonsense (the default), and a fraction as nonsense too', () => {
    expect(loadMonitorConfig({ FAIL_THRESHOLD: '-3' }).failThreshold).toBe(2)
    expect(loadMonitorConfig({ FAIL_THRESHOLD: '2.5' }).failThreshold).toBe(2)
  })
})
