import { z } from 'zod'
import { DEVICE_TYPES } from '@/lib/inventory/device-types'
import { isValidIp } from '@/lib/import/validators'

const port = z.number().int().min(1, 'A port must be from 1 to 65535.').max(65535, 'A port must be from 1 to 65535.')
const ip = z.string().trim().refine(isValidIp, 'Enter a valid IP address.')
const optionalText = z.string().trim().max(200).nullish().transform((v) => (v ? v : null))

export const storeSchema = z.object({
  code: z.string().trim().max(50).nullish(),
  name: z.string().trim().min(1, 'Enter the location name.').max(200),
  city: optionalText,
  zone: optionalText,
  state: optionalText,
  address: z.string().trim().max(500).nullish().transform((v) => (v ? v : null)),
  // P2-5b: the NVR fields describe the location's primary recorder (its own row; the location has no NVR columns any more).
  ip,
  rtsp_port: port.default(554),
  http_port: port.default(80),
  nvr_user: z.string().trim().min(1, 'Enter the NVR user name.').max(100),
  nvr_password: z.string().max(200).nullish(),
  channels: z.number().int().min(0).max(999).default(0),
  is_active: z.boolean().default(true),
})
export type StoreInput = z.input<typeof storeSchema>

export const deviceSchema = z.object({
  name: z.string().trim().min(1, 'Enter the device name.').max(200),
  type: z.enum(DEVICE_TYPES),
  store_id: z.uuid().nullish(),
  ip,
  tcp_port: port.nullish(),
  notes: z.string().trim().max(500).nullish().transform((v) => (v ? v : null)),
  enabled: z.boolean().default(true),
})
export type DeviceInput = z.input<typeof deviceSchema>
