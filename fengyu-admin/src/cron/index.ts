/**
 * cron-worker 入口（迁自 fengyu-client/cloudfunctions/cronTask）
 *
 * 长驻 Node 进程，使用 node-cron 在每日 03:00 Asia/Shanghai 触发 runDailyJobs()。
 * 部署形态：docker-compose `cron-worker` 服务（复用 admin 镜像，覆盖 entrypoint）。
 *
 * 启动方式：
 *   - bun run src/cron/index.ts           # 长驻调度
 *   - bun run src/cron/index.ts --once    # 立即跑一次后退出（本地冒烟 / 容器内手动触发）
 *   - node dist/cron-worker.js [--once]   # 生产容器内
 */

/**
 * 环境变量加载策略：
 *   - Docker 部署：docker-compose `env_file: .env` 已自动注入到 process.env
 *   - 本地开发：通过 `bun --env-file=.env run src/cron/index.ts` 加载（见 package.json scripts）
 *   不引入 dotenv 依赖，避免与 Next.js 的 .env 加载机制重复。
 */
import cron from 'node-cron'
import { runDailyJobs } from './run'
import { isBackupInFlight, runBackupTick } from './backup-tick'
import { maintainBackupRuntime } from './database-backup'
import { writeWorkerHeartbeat } from '@/lib/worker-heartbeat'

/** 备份队列轮询间隔：手动备份是页面上的同步等待，秒级延迟才不至于让人以为没响应。 */
const BACKUP_POLL_MS = 5_000
/** 容量信息刷新间隔；statfs + pg_database_size 不宜每跳都做。 */
const CAPACITY_REFRESH_MS = 5 * 60_000
/** 空闲心跳间隔，供 /settings/diagnostics 判活。 */
const HEARTBEAT_MS = 30_000

const ONCE = process.argv.includes('--once')
const CHECK = process.argv.includes('--check')
const ONLY = process.argv
  .find((a) => a.startsWith('--only='))
  ?.split('=')[1]
  ?.trim()

if (CHECK) {
  console.log('[cron-worker] startup check passed')
  process.exit(0)
} else if (ONCE) {
  // 本地开发 / 部署后冒烟测试：跑一次立即退出
  // 支持 --only=<stepName> 只跑指定 STEP（e2e 测试用，单 STEP 5-30s）
  runDailyJobs(ONLY ? { only: ONLY } : undefined)
    .then((result) => {
      console.log('[cron-worker] one-shot done:', JSON.stringify(result))
      process.exit(result.ok ? 0 : 1)
    })
    .catch((err) => {
      console.error('[cron-worker] one-shot failed:', err)
      process.exit(1)
    })
} else {
  // 生产：长驻调度。timezone 显式带 Asia/Shanghai；容器 TZ env 双保险（见 docker-compose.yml）
  cron.schedule(
    '0 3 * * *',
    () => {
      // 先备份再跑每日任务：dump 反映的是这批写入 STEP 执行前的状态，两者也不争 IO。
      // 与下面的 5 秒轮询撞车无妨，runBackupTick 自带进程内去重。
      runBackupTick()
        .then(() => runDailyJobs())
        .catch((err) => console.error('[cron-worker] tick error:', err))
    },
    { timezone: 'Asia/Shanghai' },
  )

  console.log('[cron-worker] scheduled at 03:00 Asia/Shanghai (cron: 0 3 * * *)')

  // 备份队列轮询 + 断点补偿：容器若在 03:00 停机，恢复后 runScheduledBackupIfDue
  // 仍会按「当日未做过」补做（它自带 hour>=3 与当日标记双重守卫）。
  // 这里不再单独写一次空闲心跳：runBackupTick 立刻就会写 busy、收尾写 idle，
  // 两者并发会撞同一个 heartbeat temp 文件（2026-09-12 的 crash-loop 根因）。
  // 每个 void 调用都必须自带 catch —— 未处理的 rejection 在 Node 22 下直接终止进程。
  void maintainBackupRuntime().catch((err) => console.error('[cron-worker] backup runtime init failed:', err))
  void runBackupTick()
  const backupPoll = setInterval(() => { void runBackupTick() }, BACKUP_POLL_MS)
  const capacityRefresh = setInterval(() => {
    void maintainBackupRuntime().catch((err) => console.error('[cron-worker] backup maintenance failed:', err))
  }, CAPACITY_REFRESH_MS)
  const heartbeat = setInterval(() => {
    // 备份在途时由 runBackupTick 自己刷 busy，这里不覆盖成 idle
    if (!isBackupInFlight()) void writeWorkerHeartbeat('cron-worker').catch(() => undefined)
  }, HEARTBEAT_MS)
  // unref：三个定时器都不该单独把进程吊住，进程存活交给 node-cron 的调度器
  backupPoll.unref()
  capacityRefresh.unref()
  heartbeat.unref()

  console.log('[cron-worker] backup queue polling every 5s; capacity refresh every 5min')

  // SIGTERM 优雅退出（compose down 时）
  process.on('SIGTERM', () => {
    clearInterval(backupPoll)
    clearInterval(capacityRefresh)
    clearInterval(heartbeat)
    console.log('[cron-worker] received SIGTERM, exiting')
    process.exit(0)
  })
}
