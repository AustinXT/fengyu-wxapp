#!/usr/bin/env bun
/**
 * 跨门店疗程卡：展示跟顾客走 + 使用限当前绑定门店 冒烟
 *
 * 场景：顾客转店到 B（bound_store_id=B），疗程卡在旧店 A 售出（sale_items.store_id=A）。
 * 店长在绑定门店 B 操作，验证：
 *   1. customer.paidOrders 跨门店列出旧店 A 的疗程卡（展示跟顾客走）
 *   2. service.create 在 B（=绑定门店）消费旧店 A 卡 成功（使用限绑定门店：B==B 通过；卡跨店可核销）
 *   3. start → complete → confirm 链路把旧店 A 卡扣次 成功（finalize 去掉门店条件）
 */
import './setup.mjs'
import {
  NS, TEST_STORE_ID, TEST_MARKET_ORG_ID,
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
const rec = (l) => console.log(l)

const OLD_STORE_ID = `${NS}_STORE_OLD`
const OLD_STORE_ORG = `${NS}_STORE_OLD_ORG`

async function main() {
  rec(`[smoke-cross-store-card] start | ${new Date().toISOString()}`)

  await cleanupTestData(NS)
  await ensureTestStore()                                   // 当前/绑定门店 B = TEST_STORE_ID
  await createTestStaff()                                   // 店长 scope=B，操作门店=B
  await createTestClient({ boundStoreId: TEST_STORE_ID })   // 顾客转店后绑定 B

  // 旧店 A（疗程卡售出门店，同市场，补 stores 行保证 FK 完整）
  await pgQuery(
    `INSERT INTO org_nodes (id, name, type, parent_id, sort_order, is_active)
     VALUES ($1, $2, '门店', $3, 0, true) ON CONFLICT (id) DO NOTHING`,
    [OLD_STORE_ORG, `${NS}_旧店A`, TEST_MARKET_ORG_ID]
  )
  await pgQuery(
    `INSERT INTO stores (store_id, store_name, org_node_id, opening_date, is_closed)
     VALUES ($1, $2, $3, CURRENT_DATE, false) ON CONFLICT (store_id) DO NOTHING`,
    [OLD_STORE_ID, `${NS}_旧店A`, OLD_STORE_ORG]
  )

  // 疗程卡在旧店 A 售出（store_id=A），顾客现绑定 B
  const orderId = `${NS}_XSTORE`
  await createTestSaleOrder({
    saleOrderId: orderId, clientUserId: TEST_CLIENT_USER_ID,
    storeId: OLD_STORE_ID,
    productName: `${NS}_旧店疗程卡5次`, productType: '疗程卡',
    quantity: 1, sessionCount: 5, totalAmount: 500,
    status: '已支付', salesCategory: '他销自耗',
  })
  await pgQuery(`UPDATE sale_orders SET received = total_amount WHERE sale_order_id = $1`, [orderId])
  const orderRemark = `${NS}_跨店来源订单备注\n特殊字符<&>`
  await pgQuery(`UPDATE sale_orders SET remark = $1 WHERE sale_order_id = $2`, [orderRemark, orderId])
  await pgQuery(
    `UPDATE sale_items SET paid_sessions = session_count WHERE sale_order_id = $1`,
    [orderId],
  )
  const items = await pgQuery(`SELECT sale_item_id, store_id FROM sale_items WHERE sale_order_id = $1`, [orderId])
  const saleItemId = items[0].sale_item_id
  rec(`  fixture: order=${orderId} item=${saleItemId} 卡售出门店=${items[0].store_id} 绑定门店=B(${TEST_STORE_ID})`)

  const errors = []

  // ── 1) 展示跟顾客走：paidOrders 跨店列出旧店 A 卡 ──
  const po = await invokeStaffApi('customer.paidOrders', {
    _testOpenid: TEST_MANAGER_OPENID,
    clientUserId: TEST_CLIENT_USER_ID,
  })
  if (po.code !== 0) {
    errors.push(`paidOrders code=${po.code} ${po.message}`)
  } else if (!JSON.stringify(po.data).includes(saleItemId)) {
    errors.push(`paidOrders 应跨门店列出旧店 A 的疗程卡，实际=${JSON.stringify(po.data)}`)
  } else if (po.data.find((order) => order.saleOrderId === orderId)?.items?.[0]?.orderRemark !== orderRemark) {
    errors.push('paidOrders 应返回疗程卡来源订单备注')
  } else {
    rec('  ✓ paidOrders 跨门店列出旧店 A 疗程卡并返回来源订单备注')
  }

  // ── 2) 使用限绑定门店：在 B（=绑定门店）消费旧店 A 卡 成功 ──
  const created = await invokeStaffApi('service.create', {
    _testOpenid: TEST_MANAGER_OPENID,
    clientUserId: TEST_CLIENT_USER_ID,
    items: [{ saleItemId, sessionUsed: 1, employeeId: TEST_MANAGER_EMP_ID, serviceDuration: 60 }],
  })
  let serviceOrderId = null
  if (created.code !== 0) {
    errors.push(`绑定门店 service.create 应成功，实际 code=${created.code} ${created.message}`)
  } else {
    serviceOrderId = created.data?.serviceOrderId
    rec(`  ✓ 绑定门店(B) service.create 消费旧店 A 卡 成功（${serviceOrderId}）`)
  }

  // ── 3) start → complete → confirm 扣次 ──
  if (serviceOrderId) {
    await invokeStaffApi('service.start', { _testOpenid: TEST_MANAGER_OPENID, serviceOrderId })
    await invokeStaffApi('service.complete', { _testOpenid: TEST_MANAGER_OPENID, serviceOrderId })
    const confirmed = await invokeStaffApi('service.confirm', { _testOpenid: TEST_MANAGER_OPENID, serviceOrderId })
    if (confirmed.code !== 0) {
      errors.push(`确认核销应成功，实际 code=${confirmed.code} ${confirmed.message}`)
    } else {
      const after = await pgQuery(`SELECT remaining_sessions FROM sale_items WHERE sale_item_id = $1`, [saleItemId])
      if (Number(after[0]?.remaining_sessions) !== 4) {
        errors.push(`确认核销后旧店 A 卡剩余应=4，实际=${after[0]?.remaining_sessions}`)
      } else {
        rec('  ✓ confirm 跨店扣次成功（旧店 A 卡 5→4）')
      }
    }
  }

  // ── 4) 负向：把顾客绑定门店改到旧店 A，则在 B 开单被拒（使用限当前绑定门店）──
  await pgQuery(`UPDATE client_wechat_users SET bound_store_id = $1 WHERE user_id = $2`, [OLD_STORE_ID, TEST_CLIENT_USER_ID])
  const denied = await invokeStaffApi('service.create', {
    _testOpenid: TEST_MANAGER_OPENID,
    clientUserId: TEST_CLIENT_USER_ID,
    items: [{ saleItemId, sessionUsed: 1, employeeId: TEST_MANAGER_EMP_ID, serviceDuration: 60 }],
  })
  if (denied.code === 0) {
    errors.push('顾客绑定门店≠本门店时 service.create 应被拒，实际成功')
  } else if (!String(denied.message || '').includes('绑定门店')) {
    errors.push(`拒绝消息应含 '绑定门店'，实际 ${denied.message}`)
  } else {
    rec(`  ✓ 非绑定门店开单被拒（${denied.message}）`)
  }

  if (errors.length) {
    rec(`  ✗ FAIL: ${errors.length} 项断言失败`)
    for (const e of errors) rec(`    - ${e}`)
    return
  }

  pass = true
  exitCode = 0
  rec('  ✅ PASS — 跨店卡展示跟顾客走 + 绑定门店消费/核销 正确')
}

try {
  await main()
} catch (e) {
  console.error('[smoke-cross-store-card] EXCEPTION:', e.message)
  if (e?.stack) console.error(e.stack)
} finally {
  try { await cleanupTestData(NS) } catch (e) { console.error('[cleanup error]', e.message) }
  await closePool()
  console.log(`[smoke-cross-store-card] end | ${pass ? 'PASS' : 'FAIL'} | exit=${exitCode}`)
  process.exit(exitCode)
}
