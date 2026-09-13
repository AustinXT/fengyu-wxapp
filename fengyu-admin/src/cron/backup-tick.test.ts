import { readFileSync } from 'node:fs'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('./database-backup', () => ({
  runScheduledBackupIfDue: vi.fn(async () => null),
  processManualBackupRequests: vi.fn(async () => undefined),
}))
vi.mock('@/lib/worker-heartbeat', () => ({
  writeWorkerHeartbeat: vi.fn(async () => undefined),
}))

import { isBackupInFlight, runBackupTick } from './backup-tick'
import { processManualBackupRequests, runScheduledBackupIfDue } from './database-backup'
import { writeWorkerHeartbeat } from '@/lib/worker-heartbeat'

const scheduled = runScheduledBackupIfDue as unknown as ReturnType<typeof vi.fn>
const manual = processManualBackupRequests as unknown as ReturnType<typeof vi.fn>
const heartbeat = writeWorkerHeartbeat as unknown as ReturnType<typeof vi.fn>

describe('runBackupTick', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    scheduled.mockResolvedValue(null)
    manual.mockResolvedValue(undefined)
    heartbeat.mockResolvedValue(undefined)
  })
  afterEach(() => { vi.restoreAllMocks() })

  it('一跳依次跑定时备份补偿与手动请求消费', async () => {
    await runBackupTick()

    expect(scheduled).toHaveBeenCalledTimes(1)
    expect(manual).toHaveBeenCalledTimes(1)
    // 手动请求必须在定时补偿之后消费，避免两者并发抢 backup.lock
    expect(scheduled.mock.invocationCallOrder[0]).toBeLessThan(manual.mock.invocationCallOrder[0])
  })

  it('心跳先置 busy、收尾复位 idle', async () => {
    await runBackupTick()

    expect(heartbeat).toHaveBeenNthCalledWith(1, 'cron-worker', 'busy', '检查数据库备份队列')
    expect(heartbeat).toHaveBeenLastCalledWith('cron-worker')
  })

  it('在途时重复调用被去重，不会每跳都抢 backup.lock', async () => {
    // 闸门必须在 tick 之前建好：mock 实现要等心跳 await 让出微任务后才跑，
    // 若在实现里才赋值 release，主线程这边拿到的还是初始空函数，promise 永不 resolve。
    let release!: () => void
    const gate = new Promise<null>((resolve) => { release = () => resolve(null) })
    scheduled.mockReturnValue(gate)

    const first = runBackupTick()
    const second = runBackupTick()
    const third = runBackupTick()
    expect(second).toBe(first)
    expect(third).toBe(first)
    expect(isBackupInFlight()).toBe(true)

    release()
    await first
    // 三次调用只落成一次真实执行
    expect(scheduled).toHaveBeenCalledTimes(1)
    expect(manual).toHaveBeenCalledTimes(1)
    expect(isBackupInFlight()).toBe(false)
  })

  it('上一跳结束后可以再次执行（守卫不是一次性闸门）', async () => {
    await runBackupTick()
    await runBackupTick()

    expect(scheduled).toHaveBeenCalledTimes(2)
  })

  it('异常被吞掉并记日志，且在途标记复位，不会打挂 worker', async () => {
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {})
    scheduled.mockRejectedValue(new Error('pg_dump exited with 1'))

    await expect(runBackupTick()).resolves.toBeUndefined()

    expect(logged).toHaveBeenCalledWith('[cron-worker] backup tick failed:', expect.any(Error))
    expect(isBackupInFlight()).toBe(false)
    // 失败后心跳仍要复位，否则诊断页会永远停在 busy
    expect(heartbeat).toHaveBeenLastCalledWith('cron-worker')
  })
})

/**
 * 接线守卫。2026-08-23 的 merge 0bcad805 把 index.ts 取成了不含备份接线的一侧，
 * database-backup.ts 沦为无调用方的孤儿，定时备份静默失效近一个月
 * （prod 备份目录一个文件都没有）。行为测试盖不到 index.ts 的 import 副作用，
 * 所以这里对源码本身下断言——合并再把接线弄丢时，这条会红。
 */
describe('cron 入口备份接线', () => {
  const source = readFileSync(path.join(__dirname, 'index.ts'), 'utf8')

  it('注册了备份轮询与容量刷新定时器', () => {
    expect(source).toContain('runBackupTick')
    expect(source).toContain('setInterval')
    expect(source).toContain('BACKUP_POLL_MS')
    expect(source).toContain('maintainBackupRuntime')
  })

  it('cron-worker 会写心跳（诊断页据此判活）', () => {
    expect(source).toContain('writeWorkerHeartbeat')
  })
})
