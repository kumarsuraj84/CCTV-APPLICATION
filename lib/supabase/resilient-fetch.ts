const TIMEOUT_MS = 20_000

/** fetch with a time limit; a GET or HEAD that fails on the network is tried once more. Writes are never repeated. */
export async function resilientFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const method = (init?.method ?? (input instanceof Request ? input.method : 'GET')).toUpperCase()
  const attempts = method === 'GET' || method === 'HEAD' ? 2 : 1
  let lastError: unknown
  for (let attempt = 0; attempt < attempts; attempt++) {
    const timeout = AbortSignal.timeout(TIMEOUT_MS)
    const signal = init?.signal ? AbortSignal.any([init.signal, timeout]) : timeout
    try {
      return await fetch(input, { ...init, signal })
    } catch (err) {
      lastError = err
      if (init?.signal?.aborted) break
    }
  }
  throw lastError
}
