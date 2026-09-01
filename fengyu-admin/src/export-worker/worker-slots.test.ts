import { describe, expect, it, vi } from 'vitest'
import { createSerializedAsyncRunner, runWorkerSlots } from './worker-slots'

function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>((done) => { resolve = done })
  return { promise, resolve }
}

describe('export worker 双槽调度', () => {
  it('最多并发两个任务，任一槽释放后第三个任务才开始', async () => {
    const jobs = [1, 2, 3]
    const gates = new Map([[1, deferred()], [2, deferred()], [3, deferred()]])
    const started: number[] = []
    let active = 0
    let maxActive = 0
    let stopping = false

    const running = runWorkerSlots({
      concurrency: 2,
      shouldStop: () => stopping,
      runMaintenance: async () => undefined,
      claimNextJob: async () => jobs.shift() ?? null,
      processJob: async (job) => {
        started.push(job)
        active += 1
        maxActive = Math.max(maxActive, active)
        await gates.get(job)!.promise
        active -= 1
      },
      waitWhenIdle: async () => undefined,
      onLoopError: vi.fn(),
    })

    await vi.waitFor(() => expect(started).toEqual([1, 2]))
    expect(started).not.toContain(3)
    gates.get(1)!.resolve()
    await vi.waitFor(() => expect(started).toContain(3))
    stopping = true
    gates.get(2)!.resolve()
    gates.get(3)!.resolve()
    await running

    expect(maxActive).toBe(2)
  })

  it('一个任务失败不会终止另一个槽位或整个调度器', async () => {
    const jobs = [1, 2]
    const errors: unknown[] = []
    const completed: number[] = []
    let stopping = false

    await runWorkerSlots({
      concurrency: 2,
      shouldStop: () => stopping,
      runMaintenance: async () => undefined,
      claimNextJob: async () => jobs.shift() ?? null,
      processJob: async (job) => {
        if (job === 1) throw new Error('job one failed')
        completed.push(job)
        stopping = true
      },
      waitWhenIdle: async () => undefined,
      onLoopError: (error) => errors.push(error),
    })

    expect(completed).toEqual([2])
    expect(errors).toHaveLength(1)
  })

  it('heartbeat 写入串行执行，避免并发复用临时文件', async () => {
    let active = 0
    let maxActive = 0
    let writes = 0
    const publish = createSerializedAsyncRunner(async () => {
      active += 1
      maxActive = Math.max(maxActive, active)
      await new Promise((resolve) => setTimeout(resolve, 5))
      writes += 1
      active -= 1
    })

    await Promise.all([publish(), publish(), publish()])

    expect(writes).toBe(3)
    expect(maxActive).toBe(1)
  })
})
