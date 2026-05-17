#!/usr/bin/env bun
/**
 * customer.paidOrders + giftHistory + refundHistory 冒烟
 *
 * 验证：3 个历史查询接口都返回正常结构（不崩溃）
 */
import './setup.mjs'
import { NS, TEST_MANAGER_OPENID, TEST_CLIENT_USER_ID, closePool } from './setup.mjs'
import { invokeStaffApi } from './helpers/invoke.mjs'
import { ensureTestStore, createTestStaff, createTestClient, createTestSaleOrder, cleanupTestData } from './helpers/fixtures.mjs'
import { pgQuery } from './setup.mjs'

let pass = false; let exitCode = 1
function rec(line) { console.log(line) }

async function main() {
  rec(`[smoke-customer-history] start`)
  await cleanupTestData(NS)
  await ensureTestStore()
  await createTestStaff()
  await createTestClient()

  // 造一个已支付订单
  const orderId = `${NS}_HIS_OD`
  await createTestSaleOrder({
    saleOrderId: orderId, clientUserId: TEST_CLIENT_USER_ID,
    productType: '单品', totalAmount: 500, status: '已支付', salesCategory: '他销自耗',
  })
  await pgQuery(`UPDATE sale_orders SET paid_at = NOW(), received = total_amount WHERE sale_order_id = $1`, [orderId])

  const errors = []
  for (const action of ['customer.paidOrders', 'customer.giftHistory', 'customer.refundHistory']) {
    const r = await invokeStaffApi(action, {
      _testOpenid: TEST_MANAGER_OPENID, clientUserId: TEST_CLIENT_USER_ID,
    })
    if (r.code !== 0) errors.push(`${action} code=${r.code} msg=${r.message}`)
    else rec(`  ✓ ${action} OK (return shape: ${Object.keys(r.data || {}).join(',')})`)
  }

  if (errors.length) {
    rec(`  ✗ FAIL`); for (const e of errors) rec(`    - ${e}`); return
  }
  pass = true; exitCode = 0
  rec(`  ✅ PASS — 3 个历史查询 API 正常`)
}

try { await main() } catch (e) { console.error('EXCEPTION:', e.message); console.error(e.stack) }
finally {
  try { await cleanupTestData(NS) } catch {}
  await closePool()
  console.log(`[smoke-customer-history] end | ${pass ? 'PASS' : 'FAIL'} | exit=${exitCode}`)
  process.exit(exitCode)
}
