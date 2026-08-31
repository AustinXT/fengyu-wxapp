export interface WorkerSlotOptions<Job> {
  concurrency: number
  shouldStop: () => boolean
  runMaintenance: () => Promise<void>
  claimNextJob: () => Promise<Job | null>
  processJob: (job: Job, slot: number) => Promise<void>
  waitWhenIdle: () => Promise<void>
  onLoopError: (error: unknown, slot: number) => void
}

/**
 * 固定数量的领取槽位；claimNextJob 必须在数据库侧原子领取并使用 SKIP LOCKED。
 * 单任务失败只结束当前迭代，不会拖垮其他槽位。
 */
export async function runWorkerSlots<Job>(options: WorkerSlotOptions<Job>): Promise<void> {
  const concurrency = Math.max(1, Math.floor(options.concurrency))
  const runSlot = async (slot: number) => {
    while (!options.shouldStop()) {
      try {
        await options.runMaintenance()
        if (options.shouldStop()) break
        const job = await options.claimNextJob()
        if (job) {
          await options.processJob(job, slot)
        } else {
          await options.waitWhenIdle()
        }
      } catch (error) {
        options.onLoopError(error, slot)
        await options.waitWhenIdle()
      }
    }
  }

  await Promise.all(Array.from({ length: concurrency }, (_, index) => runSlot(index + 1)))
}

/** 同一进程内串行化 heartbeat 文件替换，避免多个槽位复用同一个临时文件。 */
export function createSerializedAsyncRunner(task: () => Promise<void>): () => Promise<void> {
  let queue = Promise.resolve()
  return () => {
    queue = queue.catch(() => undefined).then(task)
    return queue
  }
}
