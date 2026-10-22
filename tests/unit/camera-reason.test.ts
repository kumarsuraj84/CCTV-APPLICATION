import { describe, expect, it } from 'vitest'
import { cameraReason, MSG_CAMERA_NOT_RESPONDING, MSG_RECORDER_NOT_REACHABLE } from '@/lib/queries/status'

// P2-2 ruling (review note 4): camera status is camera availability, so CCTV-only viewers see why a camera is offline in camera terms.
// "Recorder not reachable" when its NVR is down (cause nvr_down); otherwise "The camera is not responding." Never the NVR address,
// login, model or other recorder internals. People with the IT view of the camera's location see the checker's own words.

describe('cameraReason', () => {
  it('with the IT view: the checker\'s own text, as it is', () => {
    expect(cameraReason('The recorder refused the login.', { itView: true })).toBe('The recorder refused the login.')
    expect(cameraReason('The NVR is not reachable.', { itView: true })).toBe('The NVR is not reachable.')
  })

  it('without it: "Recorder not reachable" for an NVR that is down, and a plain camera message for everything else', () => {
    expect(cameraReason('The NVR is not reachable.', { itView: false })).toBe(MSG_RECORDER_NOT_REACHABLE)
    for (const internal of [
      'The recorder refused the login.',
      'The address saved for this NVR is not valid.',
      'The NVR has no saved password.',
      'The NVR does not offer a supported login method.',
      'The recorder does not list this camera.',
      'The camera did not answer.',
      'connect ECONNREFUSED 10.0.0.5:554',
    ]) {
      expect(cameraReason(internal, { itView: false }), internal).toBe(MSG_CAMERA_NOT_RESPONDING)
    }
    expect(MSG_RECORDER_NOT_REACHABLE).toBe('Recorder not reachable.')
  })

  it('the "NVR down" text is the one the checker writes for cause nvr_down', async () => {
    const { readFileSync } = await import('node:fs')
    const { NVR_DOWN_CAMERA_ERROR } = await import('@/lib/queries/status')
    expect(readFileSync('lib/monitor/checks.ts', 'utf8')).toContain(`method: 'nvr_down', error: '${NVR_DOWN_CAMERA_ERROR}', cause: 'nvr_down'`)
  })

  it('the camera-terms reasons the database gives (status_reasons) stay as they are', () => {
    expect(cameraReason(MSG_RECORDER_NOT_REACHABLE, { itView: false })).toBe(MSG_RECORDER_NOT_REACHABLE)
    expect(cameraReason(MSG_CAMERA_NOT_RESPONDING, { itView: false })).toBe(MSG_CAMERA_NOT_RESPONDING)
  })

  it('nothing to say gives nothing', () => {
    expect(cameraReason(null, { itView: false })).toBeNull()
    expect(cameraReason('', { itView: true })).toBeNull()
  })
})
