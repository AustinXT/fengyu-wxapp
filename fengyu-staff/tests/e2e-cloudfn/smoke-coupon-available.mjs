#!/usr/bin/env bun
/**
 * coupon.available 冒烟（按用户 + 订单上下文返回可用券）
 */
import './setup.mjs'
import { NS, TEST_MANAGER_OPENID, TEST_CLIENT_USER_ID, TEST_CLIENT_PHONE, closePool } from './setup.mjs'
import { invokeStaffApi } from './helpers/invoke.mjs'
import { ensureTestStore, createTestStaff, createTestClient, createTestProduct, createTestCoupon, cleanupTestData } from './helpers/fixtures.mjs'

let pass = false; let exitCode = 1
function rec(line) { console.log(line) }

async function main() {
  rec(`[smoke-coupon-available] start`)
  await cleanupTestData(NS)
  await ensureTestStore()
  await createTestStaff()
  await createTestClient()
  const { skuId } = await createTestProduct({ suffix: 'CP', productKind: '护理项目', productType: '疗程卡', price: 300 })
  await createTestCoupon({ minSpend: 200, discountValue: 30 })

  const r = await invokeStaffApi('coupon.available', {
    _testOpenid: TEST_MANAGER_OPENID,
    clientPhone: TEST_CLIENT_PHONE,
    items: [{ skuId, quantity: 1, price: 300 }],
  })
  if (r.code !== 0) { rec(`  ✗ FAIL code=${r.code} msg=${r.message}`); return }
  pass = true; exitCode = 0
  rec(`  ✅ PASS — coupon.available 返回 ${(r.data?.coupons || r.data || []).length || JSON.stringify(r.data).slice(0, 60)}`)
}
try { await main() } catch (e) { console.error('EXCEPTION:', e.message) }
finally { try { await cleanupTestData(NS) } catch {} ; await closePool(); console.log(`end | ${pass ? 'PASS' : 'FAIL'} | exit=${exitCode}`); process.exit(exitCode) }
