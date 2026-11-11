import { isProductionMode } from '@/lib/runtime-mode'

// Final review C-I10: how an administrator starts a stopped process. In production each one is a Windows service made by
// deploy/windows/drishti-services.ps1 (the service names below are the ones that script uses); in development an npm script.

export type DrishtiProcess = 'worker' | 'gateway'

const SERVICE: Record<DrishtiProcess, string> = { worker: 'DrishtiWorker', gateway: 'DrishtiGateway' }

/** The plain words, without markup: "start the DrishtiWorker Windows service (…)" or "run npm run worker". */
export function startHint(proc: DrishtiProcess, production: boolean = isProductionMode()): { production: boolean; command: string; service: string } {
  const service = SERVICE[proc]
  return production
    ? { production, service, command: `drishti-services.ps1 -Action Start -Service ${service}` }
    : { production, service, command: `npm run ${proc}` }
}
