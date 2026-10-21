export const DEVICE_TYPES = ['nvr', 'server', 'attendance', 'footfall', 'other'] as const
export type DeviceType = (typeof DEVICE_TYPES)[number]

export const DEVICE_TYPE_LABELS: Record<DeviceType, string> = {
  nvr: 'NVR',
  server: 'Server',
  attendance: 'Attendance machine',
  footfall: 'Footfall counter',
  other: 'Other device',
}
