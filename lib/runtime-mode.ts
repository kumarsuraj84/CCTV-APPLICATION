// The one switch between development and production (P2-6 review round 1, I-1): scripts/lib/runtime-mode.mjs, shared with the stack
// scripts. DRISHTI_ENV=production (or NODE_ENV=production) means production; any DRISHTI_ENV value other than "development" too.
import { isProductionMode as isProduction, MODE_ENV } from '../scripts/lib/runtime-mode.mjs'

type Env = Record<string, string | undefined>

export { MODE_ENV }

export const isProductionMode = (env: Env = process.env): boolean => isProduction(env)

export const isDevelopmentMode = (env: Env = process.env): boolean => !isProductionMode(env)
