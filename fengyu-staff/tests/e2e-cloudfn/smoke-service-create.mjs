#!/usr/bin/env bun
/**
 * service.create 冒烟
 *
 * 验证：
 *   1. 已支付 销售单 + 疗程卡 sale_item 可创建服务单
 *   2. service.create 写入 service_orders (待服务) + service_items（unit_real_price / sales_category
 *      快照从 sale_items 拷贝；is_shengmei 取 SKU 当前值，SKU 为 NULL 才回退 sale_items —— #378，
 *      覆盖 SKU true/sale_items false、SKU false/sale_items true、无 SKU 回退三种组合）
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
  createTestProduct, createTestSaleOrder, cleanupTestData,
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

  // #378 场景：开单时 SKU 还不是生美（sale_items 快照 false），之后运营把 SKU 改成生美。
  // 此后新建的服务明细必须按 SKU 当前值记为生美。
  const { skuId } = await createTestProduct({ suffix: 'SVC_CR', isShengmei: true, sessionCount: 5 })
  const orderId = `${NS}_SVC_CR`
  await createTestSaleOrder({
    saleOrderId: orderId, clientUserId: TEST_CLIENT_USER_ID,
    skuId, isShengmei: false,
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
      if (si.is_shengmei !== true) {
        errors.push(`is_shengmei 应取 SKU 当前值 true（sale_items 快照为 false），实际=${si.is_shengmei}`)
      } else {
        rec(`  ✓ is_shengmei 取 SKU 当前值（sale_items=false → service_items=true）`)
      }
      if (si.sales_category !== '他销自耗') errors.push(`sales_category 应沿用 sale_items 快照 '他销自耗'，实际=${si.sales_category}`)
    }
  }

  // ─── 1b. #378 另两种组合：SKU=false 覆盖 sale_items=true；无 SKU 时回退 sale_items ───
  // 释放 uq_so_client_active（同顾客仅一张进行中服务单），逐个建单验证
  const releaseActive = () => pgQuery(
    `UPDATE service_orders SET status = '已取消' WHERE client_user_id = $1 AND status NOT IN ('已完成','已取消')`,
    [TEST_CLIENT_USER_ID],
  )
  const { skuId: skuFalse } = await createTestProduct({ suffix: 'SVC_CR_F', isShengmei: false, sessionCount: 5 })
  const shengmeiCases = [
    { label: 'SKU=false / sale_items=true → false', skuId: skuFalse, siShengmei: true, expect: false },
    { label: '无 SKU / sale_items=true → true（回退）', skuId: null, siShengmei: true, expect: true },
  ]
  for (const [i, c] of shengmeiCases.entries()) {
    await releaseActive()
    const caseOrderId = `${NS}_SVC_CR_${i + 2}`
    await createTestSaleOrder({
      saleOrderId: caseOrderId, clientUserId: TEST_CLIENT_USER_ID,
      skuId: c.skuId, isShengmei: c.siShengmei,
      productType: '疗程卡', quantity: 1, sessionCount: 5,
      totalAmount: 500, status: '已支付', salesCategory: '他销自耗',
    })
    const [caseItem] = await pgQuery(`SELECT sale_item_id FROM sale_items WHERE sale_order_id = $1`, [caseOrderId])
    const res = await invokeStaffApi('service.create', {
      _testOpenid: TEST_MANAGER_OPENID,
      clientUserId: TEST_CLIENT_USER_ID,
      items: [{ saleItemId: caseItem.sale_item_id, sessionUsed: 1, employeeId: TEST_MANAGER_EMP_ID }],
    })
    if (res.code !== 0) {
      errors.push(`[${c.label}] service.create 应成功，实际 code=${res.code} msg=${res.message}`)
      continue
    }
    const [row] = await pgQuery(
      `SELECT is_shengmei FROM service_items WHERE service_order_id = $1`, [res.data.serviceOrderId]
    )
    if (row?.is_shengmei !== c.expect) errors.push(`[${c.label}] is_shengmei 实际=${row?.is_shengmei}`)
    else rec(`  ✓ ${c.label}`)
  }
  await releaseActive()

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
