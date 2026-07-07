


import cron from 'node-cron'
import { runDailyJobs } from './run'

const ONCE = process.argv.includes('--once')
const ONLY = process.argv
  .find((a) => a.startsWith('--only='))
  ?.split('=')[1]
  ?.trim()

if (ONCE) {
  
  
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
  
  cron.schedule(
    '0 3 * * *',
    () => {
      runDailyJobs().catch((err) => console.error('[cron-worker] tick error:', err))
    },
    { timezone: 'Asia/Shanghai' },
  )

  console.log('[cron-worker] scheduled at 03:00 Asia/Shanghai (cron: 0 3 * * *)')

  
  process.on('SIGTERM', () => {
    console.log('[cron-worker] received SIGTERM, exiting')
    process.exit(0)
  })
}
