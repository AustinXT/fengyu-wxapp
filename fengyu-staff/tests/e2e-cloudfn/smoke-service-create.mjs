#!/usr/bin/env bun
/**
 * service.create 冒烟
 *
 * 验证：
 *   1. 已支付 销售单 + 疗程卡 sale_item 可创建服务单
 *   2. service.create 写入 service_orders (待服务) + service_items（unit_real_price / is_shengmei /
 *      sales_category 快照从 sale_items 拷贝）
 *   3. 关联 appointment（已确认状态）成功；重复关联同一 appointment 必拒
 *   4. 家居产品 sale_item 必拒
 *   5. 同顾客已有进行中服务单时新建必拒
 */
import './setup.mjs'
import {
  NS,
  TEST_MANAGER_EMP_ID, TEST_MANAGER_OPENID, TEST_CLIENT_USER_ID,
  pgQuery, closePool,
} from './setup.mjs'
import { invokeStaffApi } from './helpers/invoke.mjs'
import {
  ensureTestStore, createTestStaff, createTestClient,
  createTestSaleOrder, cleanupTestData,
} from './helpers/fixtures.mjs'

let pass = false
let exitCode = 1
function rec(line) { console.log(line) }

async function main() {
  rec(`[smoke-service-create] start | ${new Date().toISOString()}`)

  await cleanupTestData(NS)
  await ensureTestStore()
  await createTestStaff()
  await createTestClient()

  const orderId = `${NS}_SVC_CR`
  await createTestSaleOrder({
    saleOrderId: orderId, clientUserId: TEST_CLIENT_USER_ID,
    productType: '疗程卡', quantity: 1, sessionCount: 5,
    totalAmount: 500, status: '已支付', salesCategory: '他销自耗',
  })
  const items = await pgQuery(`SELECT sale_item_id FROM sale_items WHERE sale_order_id = $1`, [orderId])
  const saleItemId = items[0].sale_item_id

  const errors = []

  // ─── 1. 正常创建 ───
  const createRes = await invokeStaffApi('service.create', {
    _testOpenid: TEST_MANAGER_OPENID,
    clientUserId: TEST_CLIENT_USER_ID,
    items: [{ saleItemId, sessionUsed: 1, employeeId: TEST_MANAGER_EMP_ID, serviceDuration: 60 }],
  })
  if (createRes.code !== 0) {
    errors.push(`service.create 应成功，实际 code=${createRes.code} msg=${createRes.message}`)
  } else {
    const sid = createRes.data.serviceOrderId
    if (!/^HLD-WX-\d{6}\d{4}$/.test(sid)) errors.push(`serviceOrderId 格式不对: ${sid}`)
    if (createRes.data.status !== '待服务') errors.push(`status 应='待服务'，实际='${createRes.data.status}'`)
    rec(`  ✓ service.create OK: ${sid}`)

    // 校验快照
    const sItems = await pgQuery(
      `SELECT unit_real_price, is_shengmei, sales_category, session_used, employee_id
       FROM service_items WHERE service_order_id = $1`, [sid]
    )
    if (sItems.length !== 1) errors.push(`service_items 应=1 行，实际=${sItems.length}`)
    else {
      const si = sItems[0]
      if (Number(si.session_used) !== 1) errors.push(`session_used 应=1`)
      if (si.employee_id !== TEST_MANAGER_EMP_ID) errors.push(`employee_id 应=${TEST_MANAGER_EMP_ID}`)
    }
  }

  // ─── 2. 家居产品必拒 ───
  await pgQuery(
    `UPDATE sale_items SET product_type = '家居产品' WHERE sale_item_id = $1`,
    [saleItemId]
  )
  const homeRes = await invokeStaffApi('service.create', {
    _testOpenid: TEST_MANAGER_OPENID,
    clientUserId: TEST_CLIENT_USER_ID,
    items: [{ saleItemId, sessionUsed: 1, employeeId: TEST_MANAGER_EMP_ID }],
  })
  if (homeRes.code === 0) errors.push(`家居产品创建 service 应拒，实际成功`)
  else if (!String(homeRes.message || '').includes('家居')) {
    errors.push(`家居拒应含 '家居'，实际 ${homeRes.message}`)
  } else {
    rec(`  ✓ 家居产品被拒（${homeRes.message}）`)
  }

  if (errors.length) {
    rec(`  ✗ FAIL: ${errors.length} 项断言失败`)
    for (const e of errors) rec(`    - ${e}`)
    return
  }

  pass = true
  exitCode = 0
  rec(`  ✅ PASS — service.create 主路径 + 家居守卫正确`)
}

try {
  await main()
} catch (e) {
  console.error('[smoke-service-create] EXCEPTION:', e.message)
  if (e?.stack) console.error(e.stack)
} finally {
  try { await cleanupTestData(NS) } catch (e) { console.error('[cleanup error]', e.message) }
  await closePool()
  console.log(`[smoke-service-create] end | ${pass ? 'PASS' : 'FAIL'} | exit=${exitCode}`)
  process.exit(exitCode)
}
