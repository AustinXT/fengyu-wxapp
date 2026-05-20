#!/usr/bin/env bun
/**
 * RBAC × 市场级 scope 综合 smoke
 *
 * 覆盖 5 个 case：每个员工绑 market A scope（org_nodes.type='市场'）：
 *   1. manager × 市场      → staffLevel='market', scopedStores=[A1,A2], availableLoginLevels=['store','management']
 *   2. finance × 市场      → 同
 *   3. customer_mgr × 市场 → 同
 *   4. hr × 市场           → 同
 *   5. product × 市场      → 同
 *
 * 业务断言：
 *   - 所有 5 个员工以 _loginLevel='management' 登录后调 mgmtDashboard.scopeOptions 期望 code=0
 *   - 所有 5 个员工以 _loginLevel='store' 登录后业务 SQL 应能切 A1/A2 任一门店
 *   - finance/customer_mgr/hr/product 调 order.create 仍应被 requireManager 拒
 *   - market manager 调 order.create 应通过 requireManager（A1 在其 managerStoreIds 内）
 *     —— 用不存在 sku，仅断言「非 PERMISSION_DENIED」即证明过了角色门
 */
import './setup.mjs'
import {
  NS, pgQuery, TEST_MARKETS, TEST_STORES_MULTI, closePool, testPhone,
} from './setup.mjs'
import {
  createTestOrg, createTestStaffWithRoles, createTestClient,
  cleanupTestData, invalidateStaffAuthCache,
} from './helpers/fixtures.mjs'
import { invokeStaffApi } from './helpers/invoke.mjs'
import { expectOk, expectFail, runSmoke } from './helpers/rbac-asserts.mjs'

const MKT_A = TEST_MARKETS.A
const STORE_A1 = TEST_STORES_MULTI.A1
const STORE_A2 = TEST_STORES_MULTI.A2

const employees = [
  { key: 'mgr',  empId: `${NS}_RBAC_M_MGR`,  oid: `${NS}_RBAC_M_MGR_OPENID`,  ph: testPhone(3), role: 'manager' },
  { key: 'fin',  empId: `${NS}_RBAC_M_FIN`,  oid: `${NS}_RBAC_M_FIN_OPENID`,  ph: testPhone(4), role: 'finance' },
  { key: 'cm',   empId: `${NS}_RBAC_M_CM`,   oid: `${NS}_RBAC_M_CM_OPENID`,   ph: testPhone(5), role: 'customer_mgr' },
  { key: 'hr',   empId: `${NS}_RBAC_M_HR`,   oid: `${NS}_RBAC_M_HR_OPENID`,   ph: testPhone(6), role: 'hr' },
  { key: 'prod', empId: `${NS}_RBAC_M_PROD`, oid: `${NS}_RBAC_M_PROD_OPENID`, ph: testPhone(7), role: 'product' },
]

async function run() {
  await cleanupTestData(NS)
  await createTestOrg({ markets: ['A'], stores: ['A1', 'A2'] })

  for (const e of employees) {
    await createTestStaffWithRoles({
      employeeId: e.empId, openid: e.oid, phone: e.ph, name: `${NS}_市场_${e.key}`,
      storeId: STORE_A1.storeId, orgNodeId: STORE_A1.orgId,
      bindings: [{ role: e.role, scopeId: MKT_A.orgId }],
    })
  }
  await createTestClient({
    userId: `${NS}_RBAC_M_CLI`, openid: `${NS}_RBAC_M_CLI_OPENID`,
    phone: testPhone(2), boundStoreId: STORE_A1.storeId,
  })
  await invalidateStaffAuthCache(employees.map((e) => e.oid))
  await pgQuery(`SELECT 1`) // PG 连接池屏障

  const results = []

  // 1) auth.login 拿 staffLevel='market' + scopedStores=2 + availableLoginLevels=['store','management']
  for (const e of employees) {
    const r = await invokeStaffApi('auth.login', { _testOpenid: e.oid })
    const lvl = r.data?.staffLevel
    const scopedIds = (r.data?.scopedStores || []).map((s) => s.storeId).sort()
    const avail = (r.data?.availableLoginLevels || []).slice().sort()
    if (r.code !== 0) {
      results.push({ ok: false, label: `login.${e.key}`, reason: `code=${r.code} ${r.message}` })
      continue
    }
    if (lvl !== 'market') {
      results.push({ ok: false, label: `login.${e.key}.staffLevel`, reason: `expected market, got ${lvl}` })
    } else if (scopedIds.length !== 2 || !scopedIds.includes(STORE_A1.storeId) || !scopedIds.includes(STORE_A2.storeId)) {
      results.push({ ok: false, label: `login.${e.key}.scopedStores`, reason: `expected [A1,A2], got ${JSON.stringify(scopedIds)}` })
    } else if (avail.join(',') !== 'management,store') {
      results.push({ ok: false, label: `login.${e.key}.availableLoginLevels`, reason: `expected [store,management], got ${JSON.stringify(avail)}` })
    } else {
      results.push({ ok: true, label: `login.${e.key}.market×2stores×2logins` })
    }
  }

  // 2) 以 management 模式调 mgmtDashboard.scopeOptions（这是管理层准入门槛 action）
  for (const e of employees) {
    results.push(await expectOk('mgmtDashboard.scopeOptions',
      { _testOpenid: e.oid, _loginLevel: 'management' },
      `${e.key}.mgmtDashboard.scopeOptions`))
  }

  // 3) 以 store 模式 + currentStoreId=A1 调 customer.search（验证多店切单店）
  for (const e of employees) {
    results.push(await expectOk('customer.search',
      { _testOpenid: e.oid, _loginLevel: 'store', _currentStoreId: STORE_A1.storeId, keyword: NS },
      `${e.key}.customer.search@A1`))
  }

  // 4) 非 manager 角色调 order.create 应被 requireManager 拒
  const minimalCreate = {
    storeId: STORE_A1.storeId,
    items: [{ skuId: 'no-such-sku', quantity: 1 }],
    customerId: `${NS}_RBAC_M_CLI`,
  }
  for (const k of ['fin', 'cm', 'hr', 'prod']) {
    const e = employees.find((x) => x.key === k)
    results.push(await expectFail('order.create',
      { ...minimalCreate, _testOpenid: e.oid, _loginLevel: 'store', _currentStoreId: STORE_A1.storeId },
      'PERMISSION_DENIED',
      `${k}.order.create.deny`))
  }

  // 5) 市场 manager 调 order.create 应通过 requireManager（A1 在其管辖门店内）
  //    用不存在的 sku → 期望非 PERMISSION_DENIED（证明已过角色门，卡在后续业务校验）
  {
    const e = employees.find((x) => x.key === 'mgr')
    const r = await invokeStaffApi('order.create',
      { ...minimalCreate, _testOpenid: e.oid, _loginLevel: 'store', _currentStoreId: STORE_A1.storeId })
    if (r.errorType === 'PERMISSION_DENIED') {
      results.push({ ok: false, label: 'mgr.order.create.pass-guard', reason: `被 requireManager 拦: ${r.message}` })
    } else {
      results.push({ ok: true, label: `mgr.order.create.pass-guard(errorType=${r.errorType ?? 'none'})` })
    }
  }

  return results
}

await runSmoke('smoke-rbac-market-level', run, async () => {
  await cleanupTestData(NS)
  await closePool()
})
