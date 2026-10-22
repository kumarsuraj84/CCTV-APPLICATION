// One value per process, however many times the module that asks for it is loaded.
//
// Next builds route handlers, server actions and pages as separate bundles, and in development reloads modules when a file changes, so a
// plain `export const limiter = create()` can end up as several copies, each with its own count. A value kept on `globalThis` under a
// registered symbol name is the same one for every copy.

/** The value kept under this name, made by `create` the first time anyone asks. Names are shared by the whole process: use `cctv.<what>`. */
export function processSingleton<T>(name: string, create: () => T): T {
  const store = globalThis as unknown as Record<symbol, unknown>
  const key = Symbol.for(name)
  if (!(key in store)) store[key] = create()
  return store[key] as T
}
