import { z } from 'zod'
import { DEVICE_TYPES } from '@/lib/inventory/device-types'
import { isValidIp } from '@/lib/import/validators'

const port = z.number().int().min(1, 'A port must be from 1 to 65535.').max(65535, 'A port must be from 1 to 65535.')
const ip = z.string().trim().refine(isValidIp, 'Enter a valid IP address.')

// Release 1 clean-ups (T-1 review L2): the legacy location form's storeSchema moved with it to tests/setup/legacy-import.ts.

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
