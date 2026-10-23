// The limiters are kept on globalThis (lib/process-singleton.ts) so that every copy of a module shares one count. A test that wants a
// fresh count (after vi.resetModules) has to forget them as well.
const NAMES = ['cctv.liveRequestLimiter', 'cctv.playbackRequestLimiter', 'cctv.lookupRequestLimiter', 'cctv.exportRequestLimiter', 'cctv.conversionLimiter', 'cctv.fastConversionLimiter', 'cctv.fastStreamRequestLimiter', 'cctv.fastPlaybackAvailable']

export function resetProcessSingletons(): void {
  for (const name of NAMES) delete (globalThis as unknown as Record<symbol, unknown>)[Symbol.for(name)]
}
