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
import { db } from '@/db'
import { runDailyJobs } from './run'
import { refreshLakalaContracts } from './steps/refresh-lakala-contracts'
import { refreshLakalaSubMerchants } from './steps/refresh-lakala-submerchants'

const ONCE = process.argv.includes('--once')
const ONLY = process.argv
  .find((a) => a.startsWith('--only='))
  ?.split('=')[1]
  ?.trim()

export async function runHourlyLakalaJobs() {
  const [contracts, subMerchants] = await Promise.allSettled([
    refreshLakalaContracts(db),
    refreshLakalaSubMerchants(db),
  ])
  const failedSteps = [
    ...(contracts.status === 'rejected' ? ['lakalaContracts'] : []),
    ...(subMerchants.status === 'rejected' ? ['lakalaSubMerchants'] : []),
  ]
  return {
    contracts: contracts.status === 'fulfilled' ? contracts.value : null,
    subMerchants: subMerchants.status === 'fulfilled' ? subMerchants.value : null,
    errorStepCount: failedSteps.length,
    failedSteps,
  }
}

async function runOneHourlyLakalaJob(only: 'lakalaContracts' | 'lakalaSubMerchants') {
  try {
    const result = only === 'lakalaContracts'
      ? await refreshLakalaContracts(db)
      : await refreshLakalaSubMerchants(db)
    return {
      ok: true,
      errorStepCount: 0,
      summary: only === 'lakalaContracts'
        ? { lakalaContracts: result }
        : { lakalaSubMerchants: result },
    }
  } catch {
    return {
      ok: false,
      errorStepCount: 1,
      summary: { failedSteps: [only] },
    }
  }
}

if (ONCE) {
  // 本地开发 / 部署后冒烟测试：跑一次立即退出
  // 支持 --only=<stepName> 只跑指定 STEP（e2e 测试用，单 STEP 5-30s）
  const runOnce = ONLY === 'lakalaContracts' || ONLY === 'lakalaSubMerchants'
    ? () => runOneHourlyLakalaJob(ONLY)
    : () => runDailyJobs(ONLY ? { only: ONLY } : undefined)
  runOnce()
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

  // 电子合同和渠道子商户号均采用主动查询，不暴露公网回调入口。
  cron.schedule(
    '0 * * * *',
    () => {
      runHourlyLakalaJobs()
        .then((result) => {
          const level = result.errorStepCount ? console.error : console.log
          level('[cron-worker] lakala hourly poll:', JSON.stringify(result))
        })
        .catch(() => console.error('[cron-worker] lakala hourly poll failed'))
    },
    { timezone: 'Asia/Shanghai' },
  )

  console.log('[cron-worker] scheduled at 03:00 Asia/Shanghai (cron: 0 3 * * *)')
  console.log('[cron-worker] lakala contract and sub-merchant polling at minute 0 every hour')

  // SIGTERM 优雅退出（compose down 时）
  process.on('SIGTERM', () => {
    console.log('[cron-worker] received SIGTERM, exiting')
    process.exit(0)
  })
}
