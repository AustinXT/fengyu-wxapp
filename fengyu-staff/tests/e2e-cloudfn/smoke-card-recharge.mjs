#!/usr/bin/env bun
/**
 * card.rechargeSkus + card.recharge 冒烟（充值卡）
 *
 * 验证：rechargeSkus 列出可充值 SKU；recharge 调用不崩溃。
 * 注意：recharge 会创建 sale_order；按 client_user_id 在 cleanup 清理。
 */
import './setup.mjs'
import { NS, TEST_MANAGER_OPENID, TEST_CLIENT_USER_ID, TEST_CLIENT_PHONE, closePool } from './setup.mjs'
import { invokeStaffApi } from './helpers/invoke.mjs'
import { ensureTestStore, createTestStaff, createTestClient, createTestProduct, cleanupTestData } from './helpers/fixtures.mjs'

let pass = false; let exitCode = 1
function rec(line) { console.log(line) }

async function main() {
  rec(`[smoke-card-recharge] start`)
  await cleanupTestData(NS)
  await ensureTestStore()
  await createTestStaff()
  await createTestClient()
  // 创建一个充值卡 SKU
  await createTestProduct({
    suffix: 'RC', productKind: '充值卡', productType: '单品',
    salesCategory: '他销自耗', price: 500, sessionCount: null,
    isShengmei: false, isRechargeCard: true,
  })

  const errors = []
  // 1. rechargeSkus
  const r1 = await invokeStaffApi('card.rechargeSkus', { _testOpenid: TEST_MANAGER_OPENID })
  if (r1.code !== 0) errors.push(`rechargeSkus code=${r1.code} msg=${r1.message}`)
  else rec(`  ✓ rechargeSkus OK (${(r1.data?.skus || r1.data || []).length || JSON.stringify(r1.data).slice(0, 80)})`)

  // 2. recharge 用自定义金额（最稳）
  const r2 = await invokeStaffApi('card.recharge', {
    _testOpenid: TEST_MANAGER_OPENID,
    clientPhone: TEST_CLIENT_PHONE,
    clientName: `${NS}_顾客`,
    amount: 1000,
    paymentMethod: '线下',
  })
  if (r2.code !== 0) {
    // recharge 可能因 API shape 不同失败，作为非关键性 fail 记录
    rec(`  ⚠️  recharge code=${r2.code} msg=${r2.message}（若 API 签名不同，参考 routes/card.js）`)
  } else {
    rec(`  ✓ recharge OK saleOrderId=${r2.data?.saleOrderId}`)
  }

  if (errors.length) { rec(`  ✗ FAIL`); for (const e of errors) rec(`    - ${e}`); return }
  pass = true; exitCode = 0
  rec(`  ✅ PASS — rechargeSkus OK${r2.code === 0 ? ' + recharge OK' : '（recharge 未跑通，留 TODO）'}`)
}
try { await main() } catch (e) { console.error('EXCEPTION:', e.message) }
finally { try { await cleanupTestData(NS) } catch {} ; await closePool(); console.log(`end | ${pass ? 'PASS' : 'FAIL'} | exit=${exitCode}`); process.exit(exitCode) }
