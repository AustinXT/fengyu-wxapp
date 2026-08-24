import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import path from 'node:path'

export type WorkerName = 'cron-worker' | 'export-worker'

export interface WorkerHeartbeat {
  worker: WorkerName
  pid: number
  updatedAt: string
  state: 'idle' | 'busy'
  detail?: string
}

export function runtimeStatusDir(): string {
  return process.env.SYSTEM_RUNTIME_DIR?.trim() || '/var/lib/fengyu/runtime-status'
}

function heartbeatPath(worker: WorkerName): string {
  return path.join(runtimeStatusDir(), `${worker}.json`)
}

export async function writeWorkerHeartbeat(
  worker: WorkerName,
  state: WorkerHeartbeat['state'] = 'idle',
  detail?: string,
): Promise<void> {
  const dir = runtimeStatusDir()
  await mkdir(dir, { recursive: true, mode: 0o700 })
  const target = heartbeatPath(worker)
  const temp = `${target}.${process.pid}.tmp`
  const heartbeat: WorkerHeartbeat = {
    worker,
    pid: process.pid,
    updatedAt: new Date().toISOString(),
    state,
    ...(detail ? { detail: detail.slice(0, 120) } : {}),
  }
  await writeFile(temp, `${JSON.stringify(heartbeat)}\n`, { mode: 0o600 })
  await rename(temp, target)
}

export async function readWorkerHeartbeat(worker: WorkerName): Promise<WorkerHeartbeat | null> {
  try {
    const parsed = JSON.parse(await readFile(heartbeatPath(worker), 'utf8')) as Partial<WorkerHeartbeat>
    if (parsed.worker !== worker || !parsed.updatedAt || !Number.isFinite(Date.parse(parsed.updatedAt))) return null
    return {
      worker,
      pid: Number(parsed.pid) || 0,
      updatedAt: parsed.updatedAt,
      state: parsed.state === 'busy' ? 'busy' : 'idle',
      ...(typeof parsed.detail === 'string' ? { detail: parsed.detail.slice(0, 120) } : {}),
    }
  } catch {
    return null
  }
}

export function heartbeatLevel(
  heartbeat: WorkerHeartbeat | null,
  now = Date.now(),
): 'ok' | 'warn' | 'error' {
  if (!heartbeat) return 'error'
  const ageMs = now - Date.parse(heartbeat.updatedAt)
  if (!Number.isFinite(ageMs) || ageMs > 180_000) return 'error'
  if (ageMs > 90_000) return 'warn'
  return 'ok'
}
