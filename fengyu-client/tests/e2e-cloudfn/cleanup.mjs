#!/usr/bin/env bun
/**
 * 一次性清理 client L2 测试残留
 *
 * 顺序：先清 client 专属表（messages / coupons / products / appointments…）
 * 再清根 cleanupTestData（sale_orders / staff / client_wechat_users / org_nodes…）。
 *
 * 命名空间：根 NS = 'TE2L2'（= TEST_E2E_L2 缩写）
 */
import './setup.mjs'
import { NS, closePool } from './setup.mjs'
import { cleanupTestData } from '../../../tests/e2e-cloudfn/helpers/fixtures.mjs'
import { cleanupClientExtras } from './helpers/client-fixtures.mjs'

async function main() {
  console.log(`[cleanup] start | namespace=${NS} | ${new Date().toISOString()}`)
  await cleanupClientExtras(NS)
  await cleanupTestData(NS)
  console.log(`[cleanup] done`)
}

try {
  await main()
} catch (e) {
  console.error('[cleanup] EXCEPTION:', e)
  process.exitCode = 1
} finally {
  await closePool()
}
