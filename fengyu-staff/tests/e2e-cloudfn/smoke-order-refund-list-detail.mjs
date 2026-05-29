#!/usr/bin/env bun
/**
 * order.refundList + order.refundDetail 退款列表/详情冒烟
 *
 * L1 缺口：cloudfunctions/staffApi/__tests__/routes/order.test.js 完全无 refundList/
 * refundDetail describe（grep 已确认），仅含 createRefund / approveRefund / rejectRefund。
 *
 * 守护点：
 *   1. refundList 按 store_id + change_type='退款' 过滤；status 可选过滤；
 *      非 manager 自动加 operator_employee_id 过滤（只看自己发起的）
 *   2. refundDetail 按 sop.id 查；含 payment + items 拆分（来自 note JSON）
 *   3. refundDetail 老前端兼容分支：`saleOrderId` 数字时当 paymentId（order.js:3136）
 *   4. 跨店 manager 调 refundDetail → -403
 *   5. 非 manager 员工调 refundList 不看到他人发起的退款
 */
import './setup.mjs'
import {
  NS,
  TEST_MANAGER_EMP_ID, TEST_MANAGER_OPENID,
  TEST_CLIENT_USER_ID,
  TEST_STORE_ID, TEST_STORE_ORG_ID,
  TEST_MARKETS, TEST_STORES_MULTI,
  testPhone, pgQuery, closePool,
} from './setup.mjs'
import { invokeStaffApi } from './helpers/invoke.mjs'
import {
  ensureTestStore, createTestOrg, createTestStaff, createTestStaffWithRoles,
  createTestClient, createTestSaleOrder, cleanupTestData,
  invalidateStaffAuthCache,
} from './helpers/fixtures.mjs'

let pass = false
let exitCode = 1
function rec(line) { console.log(line) }

async function main() {
  rec(`[smoke-order-refund-list-detail] start | ${new Date().toISOString()}`)

  await cleanupTestData(NS)
  await ensureTestStore()
  await createTestStaff()      // manager A（默认店 TE2LS_STORE）
  await createTestClient()

  // 多店组织：建 B 市场 + B1 店，用于跨店 deny
  await createTestOrg({ markets: ['B'], stores: ['B1'] })
  const storeB1 = TEST_STORES_MULTI.B1
  // B 店 manager
  const MGR_B_OID = `${NS}_RFDLD_MGRB_OID`
  const MGR_B_EMP = `${NS}_RFDLD_MGRB`
  await createTestStaffWithRoles({
    employeeId: MGR_B_EMP,
    openid: MGR_B_OID,
    phone: testPhone(11),
    name: `${NS}_华北店长`,
    storeId: storeB1.storeId,
    orgNodeId: storeB1.orgId,
    positionName: '门店经理',
    skills: [],
    bindings: [{ role: 'manager', scopeId: storeB1.orgId }],
  })
  // 普通员工 C（A 店，非 manager），用于非 manager refundList 过滤验证
  const EMP_C_OID = `${NS}_RFDLD_EMPC_OID`
  const EMP_C_EMP = `${NS}_RFDLD_EMPC`
  await createTestStaffWithRoles({
    employeeId: EMP_C_EMP,
    openid: EMP_C_OID,
    phone: testPhone(12),
    name: `${NS}_店员C`,
    storeId: TEST_STORE_ID,
    orgNodeId: TEST_STORE_ORG_ID,
    positionName: '美容师',
    skills: [],
    bindings: [{ role: 'store_staff', scopeId: TEST_STORE_ORG_ID }],
  })
  await invalidateStaffAuthCache([TEST_MANAGER_OPENID, MGR_B_OID, EMP_C_OID])
  await pgQuery('SELECT 1') // pool barrier

  // ─── 准备两张已支付销售单 — A 店 manager 发起退款（待审批 + 已通过两单各 1）───
  const orderA1 = `${NS}_RFDLD_OA1`
  const orderA2 = `${NS}_RFDLD_OA2`
  for (const oid of [orderA1, orderA2]) {
    await createTestSaleOrder({
      saleOrderId: oid,
      clientUserId: TEST_CLIENT_USER_ID,
      productName: `${NS}_单品800`,
      productType: '疗程卡',
      quantity: 1,
      sessionCount: 1,
      totalAmount: 800,
      status: '已支付',
      salesCategory: '他销自耗',
    })
    await pgQuery(`UPDATE sale_orders SET received = total_amount WHERE sale_order_id = $1`, [oid])
  }
  const a1Items = await pgQuery(`SELECT sale_item_id FROM sale_items WHERE sale_order_id = $1`, [orderA1])
  const a2Items = await pgQuery(`SELECT sale_item_id FROM sale_items WHERE sale_order_id = $1`, [orderA2])

  const errors = []

  // ─── A 店 manager 各发起 1 张待审批 退款 ───
  const refA1 = await invokeStaffApi('order.createRefund', {
    _testOpenid: TEST_MANAGER_OPENID,
    refSaleOrderId: orderA1,
    items: [{ saleItemId: a1Items[0].sale_item_id, refundQuantity: 1 }],
    refundReason: 'e2e_listA1',
  })
  if (refA1.code !== 0) errors.push(`A1 createRefund 应成功，实际=${refA1.message}`)
  const paymentA1 = refA1.data?.paymentId

  const refA2 = await invokeStaffApi('order.createRefund', {
    _testOpenid: TEST_MANAGER_OPENID,
    refSaleOrderId: orderA2,
    items: [{ saleItemId: a2Items[0].sale_item_id, refundQuantity: 1 }],
    refundReason: 'e2e_listA2',
  })
  if (refA2.code !== 0) errors.push(`A2 createRefund 应成功，实际=${refA2.message}`)
  const paymentA2 = refA2.data?.paymentId

  // A2 单审批通过（用于覆盖 status 过滤路径：refundList(status='已支付')）
  const apr = await invokeStaffApi('order.approveRefund', {
    _testOpenid: TEST_MANAGER_OPENID,
    paymentId: paymentA2,
    auditRemark: 'e2e_apr',
  })
  if (apr.code !== 0) errors.push(`A2 approve 应成功，实际=${apr.message}`)

  rec(`  ✓ fixture: paymentA1=${paymentA1}(待审批) paymentA2=${paymentA2}(已支付)`)

  // ─── 1. refundList 不带 status — A manager 看到 2 张 ───
  const listAll = await invokeStaffApi('order.refundList', {
    _testOpenid: TEST_MANAGER_OPENID,
    page: 1,
    pageSize: 50,
  })
  if (listAll.code !== 0) {
    errors.push(`refundList(noStatus) 应成功，实际=${listAll.message}`)
  } else {
    const refunds = listAll.data?.refunds || []
    const ids = refunds.map(r => Number(r.payment_id))
    if (!ids.includes(Number(paymentA1)) || !ids.includes(Number(paymentA2))) {
      errors.push(`refundList(noStatus) 应含 paymentA1+A2，实际 ids=${JSON.stringify(ids)}`)
    }
    const a1Row = refunds.find(r => Number(r.payment_id) === Number(paymentA1))
    if (a1Row) {
      // 字段完整性断言（与 order.js:3098-3120 SELECT 列对齐）
      const required = ['payment_id', 'ref_sale_order_id', 'amount', 'status', 'payment_method',
                        'created_at', 'client_phone', 'opened_by', 'opened_by_name']
      for (const k of required) {
        if (!(k in a1Row)) errors.push(`refundList.row 缺字段 '${k}'`)
      }
      if (a1Row.ref_sale_order_id !== orderA1) {
        errors.push(`refundList[A1].ref_sale_order_id 应=${orderA1}，实际=${a1Row.ref_sale_order_id}`)
      }
    }
    rec(`  ✓ refundList(noStatus) manager A: ${refunds.length} 行`)
  }

  // ─── 2. refundList(status='待审批') — 只看到 A1 ───
  const listPending = await invokeStaffApi('order.refundList', {
    _testOpenid: TEST_MANAGER_OPENID,
    status: '待审批',
  })
  if (listPending.code !== 0) {
    errors.push(`refundList(待审批) 应成功，实际=${listPending.message}`)
  } else {
    const ids = (listPending.data?.refunds || []).map(r => Number(r.payment_id))
    if (!ids.includes(Number(paymentA1))) errors.push(`refundList(待审批) 应含 A1`)
    if (ids.includes(Number(paymentA2))) errors.push(`refundList(待审批) 不该含已通过的 A2`)
    rec(`  ✓ refundList(待审批): 含 A1 不含 A2`)
  }

  // ─── 3. refundList(status='已支付') — 只看到 A2 ───
  const listApproved = await invokeStaffApi('order.refundList', {
    _testOpenid: TEST_MANAGER_OPENID,
    status: '已支付',
  })
  if (listApproved.code !== 0) {
    errors.push(`refundList(已支付) 应成功，实际=${listApproved.message}`)
  } else {
    const ids = (listApproved.data?.refunds || []).map(r => Number(r.payment_id))
    if (!ids.includes(Number(paymentA2))) errors.push(`refundList(已支付) 应含 A2`)
    if (ids.includes(Number(paymentA1))) errors.push(`refundList(已支付) 不该含待审批的 A1`)
    rec(`  ✓ refundList(已支付): 含 A2 不含 A1`)
  }

  // ─── 4. refundDetail({paymentId}) — A1 标准入参 ───
  const detA1 = await invokeStaffApi('order.refundDetail', {
    _testOpenid: TEST_MANAGER_OPENID,
    paymentId: paymentA1,
  })
  if (detA1.code !== 0) {
    errors.push(`refundDetail(A1) 应成功，实际=${detA1.message}`)
  } else {
    // refundDetail 返回顶层结构（order.js:3206-3240）：{ payment, detail, origOrder, refundItems }
    const p = detA1.data?.payment || {}
    const d = detA1.data?.detail || {}
    const og = detA1.data?.origOrder || {}
    const refundItems = detA1.data?.refundItems || []
    if (Number(p.paymentId) !== Number(paymentA1)) errors.push(`payment.paymentId 应=${paymentA1}，实际=${p.paymentId}`)
    if (p.saleOrderId !== orderA1) errors.push(`payment.saleOrderId 应=${orderA1}`)
    if (Number(p.amount) !== -800) errors.push(`payment.amount 应=-800，实际=${p.amount}`)
    if (p.changeType !== '退款') errors.push(`payment.changeType 应='退款'，实际='${p.changeType}'`)
    if (!d.operatorName) errors.push(`detail.operatorName 应非空（JOIN staff_wechat_users）`)
    if (d.operatorEmployeeId !== TEST_MANAGER_EMP_ID) errors.push(`detail.operatorEmployeeId 应=${TEST_MANAGER_EMP_ID}`)
    if (Number(og.totalAmount) !== 800) errors.push(`origOrder.totalAmount 应=800，实际=${og.totalAmount}`)
    if (refundItems.length !== 1) errors.push(`refundItems 应=1 行，实际=${refundItems.length}`)
    else {
      if (refundItems[0].saleItemId !== a1Items[0].sale_item_id) {
        errors.push(`refundItems[0].saleItemId 应=${a1Items[0].sale_item_id}，实际=${refundItems[0].saleItemId}`)
      }
      if (!('refundAmount' in refundItems[0])) errors.push(`refundItems[0] 缺 refundAmount`)
      if (!('productName' in refundItems[0])) errors.push(`refundItems[0] 缺 productName（JOIN sale_items）`)
    }
    rec(`  ✓ refundDetail(A1): payment/detail/origOrder/refundItems 四块齐全`)
  }

  // ─── 5. refundDetail({saleOrderId: paymentId 数字}) — 兼容老前端分支 ───
  const detCompat = await invokeStaffApi('order.refundDetail', {
    _testOpenid: TEST_MANAGER_OPENID,
    saleOrderId: paymentA1,   // 数字，触发 order.js:3136 兼容分支
  })
  if (detCompat.code !== 0) {
    errors.push(`refundDetail(saleOrderId=数字兼容) 应成功，实际=${detCompat.message}`)
  } else {
    if (Number(detCompat.data?.payment?.paymentId) !== Number(paymentA1)) {
      errors.push(`refundDetail 兼容分支返回 paymentId 应=${paymentA1}`)
    }
    rec(`  ✓ refundDetail 兼容分支（saleOrderId=数字 当 paymentId）`)
  }

  // ─── 6. 跨店 manager 调 refundDetail → -403 ───
  const detCross = await invokeStaffApi('order.refundDetail', {
    _testOpenid: MGR_B_OID,
    paymentId: paymentA1,
  })
  if (detCross.code === 0) {
    errors.push(`跨店 manager 调 refundDetail 应被拒，实际成功`)
  } else if (detCross.code !== -403 || !/PERMISSION_DENIED|无权/.test(detCross.message || '')) {
    errors.push(`跨店 manager refundDetail 应返回 -403 PERMISSION_DENIED，实际 code=${detCross.code} msg=${detCross.message}`)
  } else {
    rec(`  ✓ 跨店 manager refundDetail → -403 (${detCross.message})`)
  }

  // ─── 7. 非 manager 员工 C 调 refundList — 仅看自己发起，A1/A2 由 manager 发起故不含 ───
  const listEmpC = await invokeStaffApi('order.refundList', {
    _testOpenid: EMP_C_OID,
  })
  if (listEmpC.code !== 0) {
    errors.push(`非 manager refundList 应成功，实际=${listEmpC.message}`)
  } else {
    const ids = (listEmpC.data?.refunds || []).map(r => Number(r.payment_id))
    if (ids.includes(Number(paymentA1)) || ids.includes(Number(paymentA2))) {
      errors.push(`非 manager refundList 不该含他人发起的退款，实际 ids=${JSON.stringify(ids)}`)
    }
    rec(`  ✓ 非 manager refundList 不含他人发起的退款（仅自己）`)
  }

  if (errors.length) {
    rec(`  ✗ FAIL: ${errors.length} 项断言失败`)
    for (const e of errors) rec(`    - ${e}`)
    return
  }

  pass = true
  exitCode = 0
  rec(`  ✅ PASS — refundList × 3 过滤 + refundDetail × 2 入参 + 跨店 deny + 非 manager 过滤`)
}

try {
  await main()
} catch (e) {
  console.error('[smoke-order-refund-list-detail] EXCEPTION:', e.message)
  if (e?.stack) console.error(e.stack)
} finally {
  try { await cleanupTestData(NS) } catch (e) { console.error('[cleanup error]', e.message) }
  await closePool()
  console.log(`[smoke-order-refund-list-detail] end | ${pass ? 'PASS' : 'FAIL'} | exit=${exitCode}`)
  process.exit(exitCode)
}
