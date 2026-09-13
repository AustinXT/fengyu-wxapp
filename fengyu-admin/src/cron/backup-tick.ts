/**
 * 备份轮询的单次「跳动」。
 *
 * 独立成模块（而非内联在 index.ts）有两个理由：
 * 1. index.ts 是带副作用的入口（import 即注册定时器），几乎无法单测；这里可以被行为级覆盖，
 *    见 backup-tick.test.ts。
 * 2. 2026-08-23 的 merge 0bcad805 把 index.ts 整体取成了不含备份接线的一侧，
 *    定时备份因此静默失效近一个月而无人发现（database-backup.ts 变成了没有调用方的孤儿）。
 *    把逻辑挪出来 + 配套测试，是为了让同类回归有东西能挡。
 */
import {
  processManualBackupRequests,
  runScheduledBackupIfDue,
} from './database-backup'
import { writeWorkerHeartbeat } from '@/lib/worker-heartbeat'

/** 进程内在途标记。 */
let inFlight: Promise<void> | null = null

/** 备份是否在途。空闲心跳据此避让，避免把 runBackupTick 写的 busy 覆盖成 idle。 */
export function isBackupInFlight(): boolean {
  return inFlight !== null
}

/**
 * 跑一次备份队列检查：补做当日定时备份 → 消费手动备份请求，并顺带刷 cron-worker 心跳。
 *
 * `inFlight` 是**进程内**重入守卫，不能省。`performDatabaseBackup` 里的 `backup.lock`
 * 只防跨进程：单次 dump 远超轮询间隔，没有这个守卫时后续每一跳都会抢锁失败，
 * 进而每 5 秒写一条 failed 状态 + 一条失败审计日志 + 推一次企微告警。
 *
 * 任何异常都在这里吞掉并记日志：轮询由 setInterval 驱动，抛出去只会变成
 * unhandledRejection 打挂整个 worker。
 */
export function runBackupTick(): Promise<void> {
  if (inFlight) return inFlight
  inFlight = (async () => {
    // 心跳纯属可观测性，**绝不能挡住备份本身**：它写的是 SYSTEM_RUNTIME_DIR 下的临时文件，
    // 卷满 / 权限变更 / mkdir-rename 抖动都会抛。不吞掉的话这里一抛，下面两行连跑都不跑，
    // 自动备份再次静默失效——正是本模块头注释要防的那类回归。收尾那次心跳早已这样保护。
    await writeWorkerHeartbeat('cron-worker', 'busy', '检查数据库备份队列').catch(() => undefined)
    await runScheduledBackupIfDue()
    await processManualBackupRequests()
  })()
    .catch((error) => console.error('[cron-worker] backup tick failed:', error))
    .finally(async () => {
      inFlight = null
      await writeWorkerHeartbeat('cron-worker').catch(() => undefined)
    })
  return inFlight
}
