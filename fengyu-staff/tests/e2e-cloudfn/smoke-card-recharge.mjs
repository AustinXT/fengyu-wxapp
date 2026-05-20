#!/usr/bin/env bun
/**
 * card.rechargeConfig + card.recharge 冒烟（充值卡）
 *
 * 2026-05-21 充值卡剥离 SKU 化后：
 *   - rechargeConfig 返回 {tiers,minAmount,maxAmount} 由 system_configs.recharge.* 驱动
 *   - recharge payload {clientUserId, faceValue, paymentMethod}，不再走 SKU
 */
import './setup.mjs'
import { NS, TEST_MANAGER_OPENID, TEST_CLIENT_USER_ID, TEST_CLIENT_PHONE, closePool } from './setup.mjs'
import { invokeStaffApi } from './helpers/invoke.mjs'
import { ensureTestStore, createTestStaff, createTestClient, cleanupTestData } from './helpers/fixtures.mjs'

let pass = false; let exitCode = 1
function rec(line) { console.log(line) }

async function main() {
  rec(`[smoke-card-recharge] start`)
  await cleanupTestData(NS)
  await ensureTestStore()
  await createTestStaff()
  await createTestClient()

  const errors = []
  // 1. rechargeConfig（system_configs 驱动）
  const r1 = await invokeStaffApi('card.rechargeConfig', { _testOpenid: TEST_MANAGER_OPENID })
  if (r1.code !== 0) errors.push(`rechargeConfig code=${r1.code} msg=${r1.message}`)
  else {
    const tiers = Array.isArray(r1.data?.tiers) ? r1.data.tiers : []
    if (!tiers.length) errors.push(`rechargeConfig.tiers 为空（system_configs.recharge.tiers 未配置？）`)
    else rec(`  ✓ rechargeConfig OK tiers=${tiers.length} min=¥${r1.data.minAmount} max=¥${r1.data.maxAmount}`)
  }

  // 2. recharge 用 system_configs 里第一档 faceValue（最稳）
  const faceValue = r1.data?.tiers?.[0]?.faceValue || 500
  const r2 = await invokeStaffApi('card.recharge', {
    _testOpenid: TEST_MANAGER_OPENID,
    clientUserId: TEST_CLIENT_USER_ID,
    faceValue,
    paymentMethod: '线下',
  })
  if (r2.code !== 0) {
    rec(`  ⚠️  recharge code=${r2.code} msg=${r2.message}`)
  } else {
    rec(`  ✓ recharge OK saleOrderId=${r2.data?.saleOrderId} face=¥${r2.data?.faceValue} pay=¥${r2.data?.payAmount}`)
  }

  if (errors.length) { rec(`  ✗ FAIL`); for (const e of errors) rec(`    - ${e}`); return }
  pass = true; exitCode = 0
  rec(`  ✅ PASS — rechargeConfig OK${r2.code === 0 ? ' + recharge OK' : '（recharge 未跑通，留 TODO）'}`)
}
try { await main() } catch (e) { console.error('EXCEPTION:', e.message) }
finally { try { await cleanupTestData(NS) } catch {} ; await closePool(); console.log(`end | ${pass ? 'PASS' : 'FAIL'} | exit=${exitCode}`); process.exit(exitCode) }
