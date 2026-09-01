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
      runDailyJobs().catch((err) => console.error('[cron-worker] tick error:', err))
    },
    { timezone: 'Asia/Shanghai' },
  )

  console.log('[cron-worker] scheduled at 03:00 Asia/Shanghai (cron: 0 3 * * *)')

  // SIGTERM 优雅退出（compose down 时）
  process.on('SIGTERM', () => {
    console.log('[cron-worker] received SIGTERM, exiting')
    process.exit(0)
  })
}
