import { mkdtemp, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  heartbeatLevel,
  readWorkerHeartbeat,
  writeWorkerHeartbeat,
  type WorkerHeartbeat,
} from './worker-heartbeat'

function heartbeat(updatedAt: string): WorkerHeartbeat {
  return { worker: 'cron-worker', pid: 1, updatedAt, state: 'idle' }
}

describe('worker heartbeat level', () => {
  const now = Date.parse('2026-08-13T04:00:00.000Z')

  it('在 90 秒内为正常', () => {
    expect(heartbeatLevel(heartbeat('2026-08-13T03:59:00.000Z'), now)).toBe('ok')
  })

  it('90~180 秒为警告，超过 180 秒为异常', () => {
    expect(heartbeatLevel(heartbeat('2026-08-13T03:57:45.000Z'), now)).toBe('warn')
    expect(heartbeatLevel(heartbeat('2026-08-13T03:56:59.000Z'), now)).toBe('error')
    expect(heartbeatLevel(null, now)).toBe('error')
  })
})

/**
 * 2026-09-12 回归：临时文件名原先只带 pid（`${target}.${pid}.tmp`），
 * 同进程并发写心跳时两次调用共用同一个 temp，先完成的 rename 把它移走，
 * 后一个抛 ENOENT。cron-worker 启动时正好并发写两次（空闲 + 备份 busy），
 * 未处理的 rejection 直接终止进程 → crash-loop → 生产发布被自动回滚。
 */
describe('writeWorkerHeartbeat 并发写入', () => {
  let dir = ''
  const originalDir = process.env.SYSTEM_RUNTIME_DIR

  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'fy-heartbeat-'))
    process.env.SYSTEM_RUNTIME_DIR = dir
  })
  afterEach(async () => {
    if (originalDir === undefined) delete process.env.SYSTEM_RUNTIME_DIR
    else process.env.SYSTEM_RUNTIME_DIR = originalDir
    await rm(dir, { recursive: true, force: true })
  })

  it('同进程并发写不报 ENOENT，且不残留 .tmp', async () => {
    await expect(Promise.all([
      writeWorkerHeartbeat('cron-worker'),
      writeWorkerHeartbeat('cron-worker', 'busy', '检查数据库备份队列'),
      writeWorkerHeartbeat('cron-worker'),
      writeWorkerHeartbeat('cron-worker', 'busy', '再来一次'),
    ])).resolves.toBeDefined()

    const left = (await readdir(dir)).filter((n) => n.endsWith('.tmp'))
    expect(left).toEqual([])

    // 落盘内容必须是完整可解析的一条，不能是被并发截断的半截
    const read = await readWorkerHeartbeat('cron-worker')
    expect(read).not.toBeNull()
    expect(read!.worker).toBe('cron-worker')
  })

  it('两个 worker 各写各的，互不覆盖', async () => {
    await Promise.all([
      writeWorkerHeartbeat('cron-worker', 'busy', 'A'),
      writeWorkerHeartbeat('export-worker', 'idle'),
    ])

    expect((await readWorkerHeartbeat('cron-worker'))?.state).toBe('busy')
    expect((await readWorkerHeartbeat('export-worker'))?.state).toBe('idle')
  })
})
