// P2-7 (D-8): every write of the worker carries a lease name and a fencing token, and the database refuses it without a valid pair.
// Tests that write monitoring results or worker state as the worker does take a lease of their own, named "test:<uuid>" (never the
// worker's "monitor"), through these helpers. One lease per test file (cached; renewed after ten minutes); ended test leases of
// earlier files are removed when the first one is taken (worker_lease_forget_test only touches names starting with "test:").
import { randomUUID } from 'node:crypto'
import type { LeaseFence } from '@/lib/monitor/lease'
import { adminClient } from './fixtures'

type Client = ReturnType<typeof adminClient>
export type RpcAnswer = { data: unknown; error: { code?: string; message: string } | null }
export type FenceArgs = { p_lease: string; p_fencing_token: number }

/** supabase-js rpc without the generated argument types (for functions called with deliberately wrong arguments, too). */
export const rpcOf = (c: Client) => (fn: string, args: Record<string, unknown> = {}) =>
  c.rpc(fn as never, args as never) as unknown as PromiseLike<RpcAnswer>

export const testLeaseName = (): string => `test:${randomUUID()}`

/** Takes `name` for `holder` (default: a fresh one) as the service role, and returns the token. Throws when it is held by someone else. */
export async function takeTestLease(name = testLeaseName(), holder: string = randomUUID(), ttlSec = 900, client: Client = adminClient()) {
  const { data, error } = await rpcOf(client)('worker_acquire_lease', { p_name: name, p_holder: holder, p_ttl_sec: ttlSec, p_holder_info: { test: true } })
  if (error) throw new Error(`taking the test lease failed: ${error.message}`)
  const row = (data as { acquired: boolean; fencing_token: number | null }[])[0]
  if (!row?.acquired || typeof row.fencing_token !== 'number') throw new Error(`the test lease ${name} is held by someone else`)
  return { name, holder, token: row.fencing_token }
}

let shared: { at: number; args: Promise<FenceArgs>; holder: string; name: string } | null = null

/** The lease arguments of this test file's own lease, for direct calls of the fenced functions: { ...(await fenced()), p_org, ... }. */
export function fenced(): Promise<FenceArgs> {
  if (shared && Date.now() - shared.at < 600_000) return shared.args
  const name = shared?.name ?? testLeaseName()
  const holder = shared?.holder ?? randomUUID()
  const args = (async () => {
    if (!shared) await rpcOf(adminClient())('worker_lease_forget_test')
    const t = await takeTestLease(name, holder)
    return { p_lease: t.name, p_fencing_token: t.token }
  })()
  shared = { at: Date.now(), args, holder, name }
  return args
}

/** A fence for SupabaseMonitorDb with this test file's lease (what the worker's WorkerLease gives its data layer). */
export async function testFence(): Promise<LeaseFence> {
  const a = await fenced()
  return { name: a.p_lease, token: () => a.p_fencing_token, lost: () => {} }
}
