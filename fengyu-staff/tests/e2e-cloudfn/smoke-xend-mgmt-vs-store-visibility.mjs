#!/usr/bin/env bun
/**
 * 跨端可见性 smoke：同一笔已支付销售单在 4 个不同 staff 账号下的可见性差异
 *
 * 严格意义不算"跨端"（仍是 staffApi 内部），但属于"同一数据多视角"链路验证。
 * 真正的跨 staff+client 流程在 smoke-xend-scan-confirm-scope.mjs。
 *
 * 关键设计点：order.list / order.detail 对"非 manager"额外加了 preferred_employee_id 过滤
 * （routes/order.js:1303, 1360）— 所以"finance 看订单"这条路在实现上其实是受限的。
 * 本 smoke 用 manager 角色配不同 scope 来探"scope 范围决定的可见性"，避开 preferred_employee_id
 * 的二次过滤问题。
 *
 * fixture：M1-S1 (A1) 开一笔已支付单 → 4 个账号看：
 *   1. manager@A1（门店模式）    → 能看到（同店）
 *   2. manager@market_A（门店模式 切 A1）→ 能看到（同市场，按 scope 切到 A1）
 *   3. manager@market_B（门店模式 切 A1）→ 拒绝（B 市场无权切 A1）
 *   4. manager@HQ（门店模式 切 A1）    → 能看到（HQ 含全店）
 */
import './setup.mjs'
import {
  NS, TEST_HQ_ORG_ID, TEST_MARKETS, TEST_STORES_MULTI, closePool, testPhone, pgQuery,
} from './setup.mjs'
import {
  createTestOrg, createTestStaffWithRoles, createTestClient, createTestSaleOrder,
  cleanupTestData, invalidateStaffAuthCache,
} from './helpers/fixtures.mjs'
import { invokeStaffApi } from './helpers/invoke.mjs'
import { expectFail, runSmoke } from './helpers/rbac-asserts.mjs'

async function run() {
  await cleanupTestData(NS)
  await createTestOrg({ markets: ['A', 'B'], stores: ['A1', 'A2', 'B1', 'B2'] })

  const S_A1 = TEST_STORES_MULTI.A1
  const MGR_A1 = { empId: `${NS}_XEND_V_MGR`, oid: `${NS}_XEND_V_MGR_OID`, phone: testPhone(3) }
  const MGR_MA = { empId: `${NS}_XEND_V_MMA`, oid: `${NS}_XEND_V_MMA_OID`, phone: testPhone(4) }
  const MGR_MB = { empId: `${NS}_XEND_V_MMB`, oid: `${NS}_XEND_V_MMB_OID`, phone: testPhone(5) }
  const MGR_HQ = { empId: `${NS}_XEND_V_MHQ`, oid: `${NS}_XEND_V_MHQ_OID`, phone: testPhone(6) }

  await createTestStaffWithRoles({
    employeeId: MGR_A1.empId, openid: MGR_A1.oid, phone: MGR_A1.phone, name: `${NS}_A1店长`,
    storeId: S_A1.storeId, orgNodeId: S_A1.orgId,
    bindings: [{ role: 'manager', scopeId: S_A1.orgId }],
  })
  await createTestStaffWithRoles({
    employeeId: MGR_MA.empId, openid: MGR_MA.oid, phone: MGR_MA.phone, name: `${NS}_A市场经理`,
    storeId: S_A1.storeId, orgNodeId: S_A1.orgId,
    bindings: [{ role: 'manager', scopeId: TEST_MARKETS.A.orgId }],
  })
  await createTestStaffWithRoles({
    employeeId: MGR_MB.empId, openid: MGR_MB.oid, phone: MGR_MB.phone, name: `${NS}_B市场经理`,
    storeId: TEST_STORES_MULTI.B1.storeId, orgNodeId: TEST_STORES_MULTI.B1.orgId,
    bindings: [{ role: 'manager', scopeId: TEST_MARKETS.B.orgId }],
  })
  await createTestStaffWithRoles({
    employeeId: MGR_HQ.empId, openid: MGR_HQ.oid, phone: MGR_HQ.phone, name: `${NS}_HQ经理`,
    storeId: S_A1.storeId, orgNodeId: S_A1.orgId,
    bindings: [{ role: 'manager', scopeId: TEST_HQ_ORG_ID }],
  })

  // 顾客 + A1 店一笔已支付单
  const CLI = `${NS}_XEND_V_CLI`
  await createTestClient({
    userId: CLI, openid: `${NS}_XEND_V_CLI_OID`,
    phone: testPhone(7), boundStoreId: S_A1.storeId,
  })
  const ORDER = `${NS}_XEND_V_O1`
  await createTestSaleOrder({
    saleOrderId: ORDER, clientUserId: CLI, storeId: S_A1.storeId,
    openedBy: MGR_A1.empId, totalAmount: 800, status: '已支付', paymentMethod: '线下',
  })

  await invalidateStaffAuthCache([MGR_A1.oid, MGR_MA.oid, MGR_MB.oid, MGR_HQ.oid])
  await pgQuery(`SELECT 1`)

  const results = []

  // 1) manager@A1（门店模式）能 order.detail 看到该单
  // 注：sale_order_id 在 result 里键名是 sale_order_id 还是 saleOrderId 取决于 pg.query 列名转换
  // 这里采用兼容写法
  function sameOrder(data, expected) {
    // order.detail 返回 { order: {sale_order_id, ...}, items, allocations, payments }
    return data && data.order && data.order.sale_order_id === expected
  }
  const r1 = await invokeStaffApi('order.detail', { _testOpenid: MGR_A1.oid, saleOrderId: ORDER })
  results.push(r1.code === 0 && sameOrder(r1.data, ORDER)
    ? { ok: true, label: 'manager@A1 sees A1 order' }
    : { ok: false, label: 'manager@A1 sees A1 order',
        reason: `code=${r1.code} ${r1.message || ''} data.id=${r1.data?.saleOrderId || r1.data?.sale_order_id}` })

  // 2) market_A 经理（门店模式 切到 A1）能 order.detail 看到该单
  const r2 = await invokeStaffApi('order.detail', {
    _testOpenid: MGR_MA.oid, _loginLevel: 'store', _currentStoreId: S_A1.storeId,
    saleOrderId: ORDER,
  })
  results.push(r2.code === 0 && sameOrder(r2.data, ORDER)
    ? { ok: true, label: 'manager@market_A (store mode @A1) sees A1 order' }
    : { ok: false, label: 'manager@market_A detail@A1', reason: `code=${r2.code} ${r2.message || ''}` })

  // 3) market_B 经理跨市场尝试切到 A1 → 期望 PERMISSION_DENIED "无权访问该门店"
  results.push(await expectFail('order.detail',
    {
      _testOpenid: MGR_MB.oid, _loginLevel: 'store', _currentStoreId: S_A1.storeId,
      saleOrderId: ORDER,
    },
    'PERMISSION_DENIED',
    'manager@market_B order.detail@A1 → cross-market'))

  // 4) HQ 经理 切到 A1 能看到（HQ 含全部门店）
  const r4 = await invokeStaffApi('order.detail', {
    _testOpenid: MGR_HQ.oid, _loginLevel: 'store', _currentStoreId: S_A1.storeId,
    saleOrderId: ORDER,
  })
  results.push(r4.code === 0 && sameOrder(r4.data, ORDER)
    ? { ok: true, label: 'manager@HQ (store mode @A1) sees A1 order' }
    : { ok: false, label: 'manager@HQ order.detail@A1', reason: `code=${r4.code} ${r4.message || ''}` })

  return results
}

await runSmoke('smoke-xend-mgmt-vs-store-visibility', run, async () => {
  await cleanupTestData(NS)
  await closePool()
})
