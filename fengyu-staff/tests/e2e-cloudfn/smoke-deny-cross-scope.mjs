#!/usr/bin/env bun
/**
 * 跨范围越权拒绝 smoke
 *
 * 覆盖 5 个 case：所有都期望 PERMISSION_DENIED：
 *   1. manager@storeA1 调 customer.detail 传 storeA2 顾客 → utils/scope.js:202 "顾客不在当前门店范围内"
 *   2. manager@storeA1 调 order.detail 传 storeA2 订单 → utils/scope.js:226 "订单不在当前门店范围内"
 *   3. manager@storeA1 调 staff.performanceDetail 传 storeA2 员工 → utils/scope.js:252 "员工不在当前门店范围内"
 *   4. finance@marketB 调 mgmtCustomer.search(scopeType='market', scopeId=marketA) → mgmt-customer.js:45 "越权访问其他市场数据"
 *   5. finance@marketA 调 mgmtDashboard.summary(scopeType='all') → mgmt-*.js:38 "市场账号不允许查看全部市场数据"
 *
 * fixture：2 市场（A/B）× 各 2 门店（A1/A2/B1/B2）+ 4 个顾客/订单分别绑 4 个门店
 */
import './setup.mjs'
import {
  NS, TEST_MARKETS, TEST_STORES_MULTI, closePool, testPhone,
} from './setup.mjs'
import {
  createTestOrg, createTestStaffWithRoles, createTestClient, createTestSaleOrder,
  cleanupTestData, invalidateStaffAuthCache,
} from './helpers/fixtures.mjs'
import { expectFail, runSmoke } from './helpers/rbac-asserts.mjs'

async function run() {
  await cleanupTestData(NS)
  await createTestOrg({ markets: ['A', 'B'], stores: ['A1', 'A2', 'B1', 'B2'] })

  const S_A1 = TEST_STORES_MULTI.A1
  const S_A2 = TEST_STORES_MULTI.A2
  const MKT_A = TEST_MARKETS.A
  const MKT_B = TEST_MARKETS.B

  // 三个测试员工
  const MGR_A1 = { empId: `${NS}_DENY_X_MGR_A1`, oid: `${NS}_DENY_X_MGR_A1_OID`, phone: testPhone(3) }
  const FIN_MKT_A = { empId: `${NS}_DENY_X_FIN_MA`, oid: `${NS}_DENY_X_FIN_MA_OID`, phone: testPhone(4) }
  const FIN_MKT_B = { empId: `${NS}_DENY_X_FIN_MB`, oid: `${NS}_DENY_X_FIN_MB_OID`, phone: testPhone(5) }

  await createTestStaffWithRoles({
    employeeId: MGR_A1.empId, openid: MGR_A1.oid, phone: MGR_A1.phone, name: `${NS}_A1店长`,
    storeId: S_A1.storeId, orgNodeId: S_A1.orgId,
    bindings: [{ role: 'manager', scopeId: S_A1.orgId }],
  })
  await createTestStaffWithRoles({
    employeeId: FIN_MKT_A.empId, openid: FIN_MKT_A.oid, phone: FIN_MKT_A.phone, name: `${NS}_A市场财务`,
    storeId: S_A1.storeId, orgNodeId: S_A1.orgId,
    bindings: [{ role: 'finance', scopeId: MKT_A.orgId }],
  })
  await createTestStaffWithRoles({
    employeeId: FIN_MKT_B.empId, openid: FIN_MKT_B.oid, phone: FIN_MKT_B.phone, name: `${NS}_B市场财务`,
    storeId: TEST_STORES_MULTI.B1.storeId, orgNodeId: TEST_STORES_MULTI.B1.orgId,
    bindings: [{ role: 'finance', scopeId: MKT_B.orgId }],
  })

  // 另一店员（A2 店）用于 staff.performanceDetail 跨店探测
  const STAFF_A2 = { empId: `${NS}_DENY_X_STF_A2`, oid: `${NS}_DENY_X_STF_A2_OID`, phone: testPhone(6) }
  await createTestStaffWithRoles({
    employeeId: STAFF_A2.empId, openid: STAFF_A2.oid, phone: STAFF_A2.phone, name: `${NS}_A2员工`,
    storeId: S_A2.storeId, orgNodeId: S_A2.orgId,
    bindings: [{ role: 'staff', scopeId: S_A2.orgId }],
  })

  // 4 个顾客分别绑 4 个门店
  const CLI_A2 = `${NS}_DENY_X_CLI_A2`
  await createTestClient({
    userId: CLI_A2, openid: `${NS}_DENY_X_CLI_A2_OID`,
    phone: testPhone(7), boundStoreId: S_A2.storeId,
  })

  // A2 店的订单
  const ORDER_A2 = `${NS}_DENY_X_OA2`
  await createTestSaleOrder({
    saleOrderId: ORDER_A2,
    clientUserId: CLI_A2,
    storeId: S_A2.storeId,
    openedBy: MGR_A1.empId, // 无所谓 openedBy（场景是 A1 店长想读 A2 店订单）
    totalAmount: 500,
    status: '已支付',
    paymentMethod: '线下',
  })

  await invalidateStaffAuthCache([MGR_A1.oid, FIN_MKT_A.oid, FIN_MKT_B.oid, STAFF_A2.oid])

  const results = []

  // 1) A1 店长读 A2 顾客详情 → PERMISSION_DENIED
  results.push(await expectFail('customer.detail',
    { _testOpenid: MGR_A1.oid, clientUserId: CLI_A2 },
    'PERMISSION_DENIED',
    'cross-store.customer.detail'))

  // 2) A1 店长读 A2 订单详情 → INVALID_PARAMS（设计选择：order.detail 用 store_id WHERE 过滤，
  //    跨店订单返回"不存在或不属于本门店"，不暴露具体 scope 信息）
  results.push(await expectFail('order.detail',
    { _testOpenid: MGR_A1.oid, saleOrderId: ORDER_A2 },
    'INVALID_PARAMS',
    'cross-store.order.detail (impl uses INVALID_PARAMS to hide scope leakage)'))

  // 3) A1 店长读 A2 员工绩效 → PERMISSION_DENIED（assertEmployeeInScope）
  const todayMonth = new Date().toISOString().slice(0, 7)
  results.push(await expectFail('staff.performanceDetail',
    {
      _testOpenid: MGR_A1.oid, employeeId: STAFF_A2.empId,
      startDate: `${todayMonth}-01`, endDate: `${todayMonth}-28`,
    },
    'PERMISSION_DENIED',
    'cross-store.staff.performanceDetail'))

  // 4) B 市场 finance 读 A 市场 mgmt 数据 → PERMISSION_DENIED 越权访问其他市场
  results.push(await expectFail('mgmtCustomer.search',
    {
      _testOpenid: FIN_MKT_B.oid, _loginLevel: 'management',
      scopeType: 'market', scopeId: MKT_A.orgId, keyword: NS,
    },
    'PERMISSION_DENIED',
    'cross-market.mgmtCustomer.search'))

  // 5) A 市场 finance 用 scopeType='all' → PERMISSION_DENIED 市场账号不允许查全部
  const today = new Date().toISOString().slice(0, 10)
  results.push(await expectFail('mgmtDashboard.summary',
    {
      _testOpenid: FIN_MKT_A.oid, _loginLevel: 'management',
      scopeType: 'all', date: today,
    },
    'PERMISSION_DENIED',
    'market-account.scopeType=all'))

  return results
}

await runSmoke('smoke-deny-cross-scope', run, async () => {
  await cleanupTestData(NS)
  await closePool()
})
