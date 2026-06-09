/**
 * Playwright globalSetup（e2e-pages）。
 *
 * 在所有 spec / setup project 之前跑一次，于 TE2A_ 命名空间产出详情用例夹具：
 *   - 有欠款订单（orders-repayment.spec 详情用例）
 *   - 待审批退款单（refunds.spec 详情用例）
 * 把 id 写入 .e2e-detail-fixtures.json，spec module-load 期读取，使详情用例进常规 CI（不再因缺 SEED 跳过）。
 *
 * 与 chromium project 依赖的 auth.setup.ts（setup project）正交：globalSetup 先于一切运行，
 * 仅负责建库夹具，不碰登录态。
 */
import fs from 'node:fs'
import path from 'node:path'
import { seedDetailFixtures } from './fixtures/seed-detail-fixtures'

/** 简易 .env.local 解析（仅取 DATABASE_URL；避免引入 dotenv 依赖）。 */
function loadDatabaseUrlFromEnvLocal(): void {
  if (process.env.DATABASE_URL || process.env.PG_CONNECTION_STRING) return
  const envPath = path.resolve(process.cwd(), '.env.local')
  try {
    const txt = fs.readFileSync(envPath, 'utf8')
    for (const raw of txt.split('\n')) {
      const line = raw.trim()
      if (!line || line.startsWith('#')) continue
      const m = line.match(/^DATABASE_URL\s*=\s*(.*)$/)
      if (m) {
        process.env.DATABASE_URL = m[1].trim().replace(/^["']|["']$/g, '')
        break
      }
    }
  } catch {
    /* .env.local 缺失则退回 fixtures.mjs 内置默认 5434 串 */
  }
}

export default async function globalSetup() {
  // E2E_DATABASE_URL 优先（独立测试库 fengyu_e2e，与开发/staff 共用库隔离）；未设才回落 .env.local
  if (process.env.E2E_DATABASE_URL) {
    process.env.DATABASE_URL = process.env.E2E_DATABASE_URL
  }
  loadDatabaseUrlFromEnvLocal()
  const ids = await seedDetailFixtures()
  console.log(
    `[e2e globalSetup] 详情夹具就绪 — orderIdWithDebt=${ids.orderIdWithDebt} refundId=${ids.refundId}`,
  )
}
