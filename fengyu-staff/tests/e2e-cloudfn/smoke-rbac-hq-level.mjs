#!/usr/bin/env bun
/**
 * RBAC × 总部级 scope 综合 smoke
 *
 * 覆盖 5 个 case：每个员工绑总部 scope（org_nodes.type='总部'）：
 *   1. manager × 总部      → staffLevel='headquarters', scopedStores=全部门店 (A1,A2,B1,B2)
 *   2. finance × 总部
 *   3. customer_mgr × 总部
 *   4. hr × 总部
 *   5. product × 总部
 *
 * 业务断言：
 *   - 所有 5 个员工 staffLevel='headquarters' + scopedStores ≥ 4；availableLoginLevels 按
 *     permission_matrix 分流：manager/finance/hr 两档，customer_mgr/product 只有 store
 *   - 以 management 模式调 mgmtDashboard.scopeOptions 应返回 staffLevel=headquarters + 2 markets
 *   - mgmtDashboard.summary(scopeType='all') 期望 code=0
 *   - finance/customer_mgr/hr/product 调 order.create 仍被 requireManager 拒
 *   - 总部 manager 调 order.create 应通过 requireManager（A1 在其 managerStoreIds=全部门店 内）
 *     —— 用不存在 sku，仅断言「非 PERMISSION_DENIED」即证明过了角色门
 */
import './setup.mjs'
import {
  NS, pgQuery, TEST_HQ_ORG_ID, TEST_STORES_MULTI, closePool, testPhone,
} from './setup.mjs'
import {
  createTestOrg, createTestStaffWithRoles, createTestClient,
  cleanupTestData, invalidateStaffAuthCache,
} from './helpers/fixtures.mjs'
import { invokeStaffApi } from './helpers/invoke.mjs'
import { expectOk, expectFail, runSmoke } from './helpers/rbac-asserts.mjs'

const STORE_A1 = TEST_STORES_MULTI.A1

// mgmt = 该角色在 system_configs.permission_matrix 里是否有 data_center:dashboard，
// 它决定 availableLoginLevels 是否含 'management'（routes/auth.js 的 deriveAvailableLoginLevels）。
// 两库实测（2026-09-21，dev 与 prod 一致）：只有 hr / admin / finance / manager / 自定义角色有，
// **customer_mgr 与 product 没有** —— 本用例原先对 5 个角色一视同仁地要求 management，
// 那是矩阵收紧前的期望。现按矩阵分流：有权的必须进得去，无权的必须被挡住。
const employees = [
  { key: 'mgr',  empId: `${NS}_RBAC_H_MGR`,  oid: `${NS}_RBAC_H_MGR_OPENID`,  ph: testPhone(3),  role: 'manager',      mgmt: true },
  { key: 'fin',  empId: `${NS}_RBAC_H_FIN`,  oid: `${NS}_RBAC_H_FIN_OPENID`,  ph: testPhone(4),  role: 'finance',      mgmt: true },
  { key: 'cm',   empId: `${NS}_RBAC_H_CM`,   oid: `${NS}_RBAC_H_CM_OPENID`,   ph: testPhone(5),  role: 'customer_mgr', mgmt: false },
  { key: 'hr',   empId: `${NS}_RBAC_H_HR`,   oid: `${NS}_RBAC_H_HR_OPENID`,   ph: testPhone(6),  role: 'hr',           mgmt: true },
  { key: 'prod', empId: `${NS}_RBAC_H_PROD`, oid: `${NS}_RBAC_H_PROD_OPENID`, ph: testPhone(7),  role: 'product',      mgmt: false },
]
const mgmtEmployees = employees.filter((e) => e.mgmt)

async function run() {
  await cleanupTestData(NS)
  await createTestOrg({ markets: ['A', 'B'], stores: ['A1', 'A2', 'B1', 'B2'] })

  for (const e of employees) {
    await createTestStaffWithRoles({
      employeeId: e.empId, openid: e.oid, phone: e.ph, name: `${NS}_总部_${e.key}`,
      storeId: STORE_A1.storeId, orgNodeId: STORE_A1.orgId,
      bindings: [{ role: e.role, scopeId: TEST_HQ_ORG_ID }],
    })
  }
  await createTestClient({
    userId: `${NS}_RBAC_H_CLI`, openid: `${NS}_RBAC_H_CLI_OPENID`,
    phone: testPhone(2), boundStoreId: STORE_A1.storeId,
  })
  await invalidateStaffAuthCache(employees.map((e) => e.oid))
  await pgQuery(`SELECT 1`) // PG 连接池屏障

  const results = []

  // 1) auth.login: staffLevel=headquarters + scopedStores 含 4 个测试店 + availableLoginLevels 两档
  for (const e of employees) {
    const r = await invokeStaffApi('auth.login', { _testOpenid: e.oid })
    if (r.code !== 0) {
      results.push({ ok: false, label: `login.${e.key}`, reason: `code=${r.code} ${r.message}` })
      continue
    }
    const lvl = r.data?.staffLevel
    const scopedIds = (r.data?.scopedStores || []).map((s) => s.storeId)
    const avail = (r.data?.availableLoginLevels || []).slice().sort()
    const myStores = ['A1', 'A2', 'B1', 'B2'].map((k) => TEST_STORES_MULTI[k].storeId)
    const hasAll = myStores.every((id) => scopedIds.includes(id))

    if (lvl !== 'headquarters') {
      results.push({ ok: false, label: `login.${e.key}.staffLevel`, reason: `expected headquarters, got ${lvl}` })
    } else if (!hasAll) {
      results.push({ ok: false, label: `login.${e.key}.scopedStores`, reason: `expected ⊇ 4 stores, got count=${scopedIds.length}` })
    } else if (avail.join(',') !== (e.mgmt ? 'management,store' : 'store')) {
      results.push({
        ok: false, label: `login.${e.key}.availableLoginLevels`,
        reason: `expected ${e.mgmt ? '[store,management]' : '[store]（该角色无 data_center:dashboard）'}, got ${JSON.stringify(avail)}`,
      })
    } else {
      results.push({ ok: true, label: `login.${e.key}.hq×${scopedIds.length}stores` })
    }
  }

  // 2) mgmtDashboard.scopeOptions 应返回 staffLevel=headquarters + 至少 2 markets（仅限有管理层入口的角色）
  for (const e of mgmtEmployees) {
    const r = await invokeStaffApi('mgmtDashboard.scopeOptions',
      { _testOpenid: e.oid, _loginLevel: 'management' })
    if (r.code !== 0) {
      results.push({ ok: false, label: `${e.key}.scopeOptions`, reason: `code=${r.code} ${r.message}` })
    } else if (r.data?.staffLevel !== 'headquarters') {
      results.push({ ok: false, label: `${e.key}.scopeOptions.staffLevel`, reason: `got ${r.data?.staffLevel}` })
    } else if (!Array.isArray(r.data?.markets) || r.data.markets.length < 2) {
      results.push({ ok: false, label: `${e.key}.scopeOptions.markets`, reason: `markets.length=${r.data?.markets?.length}` })
    } else {
      results.push({ ok: true, label: `${e.key}.scopeOptions.hq×${r.data.markets.length}markets` })
    }
  }

  // 3) mgmtDashboard.summary(scopeType='all') 期望 code=0
  const today = new Date().toISOString().slice(0, 10)
  for (const e of mgmtEmployees) {
    results.push(await expectOk('mgmtDashboard.summary',
      { _testOpenid: e.oid, _loginLevel: 'management', scopeType: 'all', date: today },
      `${e.key}.mgmtDashboard.summary(all)`))
  }

  // 2b) 无 data_center:dashboard 的角色以 management 模式访问 → 必须被挡
  for (const e of employees.filter((x) => !x.mgmt)) {
    results.push(await expectFail('mgmtDashboard.scopeOptions',
      { _testOpenid: e.oid, _loginLevel: 'management' },
      'PERMISSION_DENIED',
      `${e.key}.scopeOptions.deny（无管理层入口）`))
  }

  // 4) 非 manager 角色调 order.create 应被拒
  const minimalCreate = {
    storeId: STORE_A1.storeId,
    items: [{ skuId: 'no-such-sku', quantity: 1 }],
    customerId: `${NS}_RBAC_H_CLI`,
  }
  for (const k of ['fin', 'cm', 'hr', 'prod']) {
    const e = employees.find((x) => x.key === k)
    results.push(await expectFail('order.create',
      { ...minimalCreate, _testOpenid: e.oid, _loginLevel: 'store', _currentStoreId: STORE_A1.storeId },
      'PERMISSION_DENIED',
      `${k}.order.create.deny`))
  }

  // 5) 总部 manager 调 order.create 应通过 requireManager（A1 在其管辖门店内）
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

await runSmoke('smoke-rbac-hq-level', run, async () => {
  await cleanupTestData(NS)
  await closePool()
})
