import { spawn as nodeSpawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import path from 'node:path'
import type { SpawnFn } from '@/lib/streams/vod'

const SCRIPT = path.resolve(__dirname, 'fake-ffmpeg.mjs')

export type FakeFfmpegMode = 'copy' | 'fail' | 'crash' | 'fail-late' | 'hang' | 'linger'

/** A spawn that starts the stand-in for ffmpeg (a real node process, see fake-ffmpeg.mjs) whatever program and arguments are asked for. */
export function fakeSpawn(mode: FakeFfmpegMode = 'copy'): SpawnFn & { children: ChildProcessWithoutNullStreams[]; calls: { command: string; args: string[] }[] } {
  const children: ChildProcessWithoutNullStreams[] = []
  const calls: { command: string; args: string[] }[] = []
  const spawn = Object.assign((command: string, args: string[]) => {
    calls.push({ command, args })
    const child = nodeSpawn(process.execPath, [SCRIPT, mode], { shell: false, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true })
    children.push(child)
    return child
  }, { children, calls })
  return spawn
}

/** True while a process with this id exists. */
export function isAlive(pid: number | undefined): boolean {
  if (pid === undefined) return false
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}
