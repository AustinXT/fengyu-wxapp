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
 *   - 所有 5 个员工 staffLevel='headquarters' + scopedStores ≥ 4 + availableLoginLevels=['store','management']
 *   - 以 management 模式调 mgmtDashboard.scopeOptions 应返回 staffLevel=headquarters + 2 markets
 *   - mgmtDashboard.summary(scopeType='all') 期望 code=0
 *   - finance/customer_mgr/hr/product 调 order.create 仍被 requireManager 拒
 */
import './setup.mjs'
import {
  NS, TEST_HQ_ORG_ID, TEST_STORES_MULTI, closePool, testPhone,
} from './setup.mjs'
import {
  createTestOrg, createTestStaffWithRoles, createTestClient,
  cleanupTestData, invalidateStaffAuthCache,
} from './helpers/fixtures.mjs'
import { invokeStaffApi } from './helpers/invoke.mjs'
import { expectOk, expectFail, runSmoke } from './helpers/rbac-asserts.mjs'

const STORE_A1 = TEST_STORES_MULTI.A1

const employees = [
  { key: 'mgr',  empId: `${NS}_RBAC_H_MGR`,  oid: `${NS}_RBAC_H_MGR_OPENID`,  ph: testPhone(3),  role: 'manager' },
  { key: 'fin',  empId: `${NS}_RBAC_H_FIN`,  oid: `${NS}_RBAC_H_FIN_OPENID`,  ph: testPhone(4),  role: 'finance' },
  { key: 'cm',   empId: `${NS}_RBAC_H_CM`,   oid: `${NS}_RBAC_H_CM_OPENID`,   ph: testPhone(5),  role: 'customer_mgr' },
  { key: 'hr',   empId: `${NS}_RBAC_H_HR`,   oid: `${NS}_RBAC_H_HR_OPENID`,   ph: testPhone(6),  role: 'hr' },
  { key: 'prod', empId: `${NS}_RBAC_H_PROD`, oid: `${NS}_RBAC_H_PROD_OPENID`, ph: testPhone(7),  role: 'product' },
]

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

  // 调试：确认 binding 真插
  const { pgQuery } = await import('./setup.mjs')
  const bindings = await pgQuery(
    `SELECT pr.employee_id, pr.role, pr.scope_id, o.type AS scope_type
     FROM permission_roles pr
     LEFT JOIN org_nodes o ON o.id = pr.scope_id
     WHERE pr.employee_id LIKE $1`,
    [`${NS}_RBAC_H%`]
  )
  console.log(`  [debug] HQ bindings inserted: ${bindings.length} | sample: ${JSON.stringify(bindings.slice(0, 2))}`)

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
    } else if (avail.join(',') !== 'management,store') {
      results.push({ ok: false, label: `login.${e.key}.availableLoginLevels`, reason: `got ${JSON.stringify(avail)}` })
    } else {
      results.push({ ok: true, label: `login.${e.key}.hq×${scopedIds.length}stores` })
    }
  }

  // 2) mgmtDashboard.scopeOptions 应返回 staffLevel=headquarters + 至少 2 markets
  for (const e of employees) {
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
  for (const e of employees) {
    results.push(await expectOk('mgmtDashboard.summary',
      { _testOpenid: e.oid, _loginLevel: 'management', scopeType: 'all', selectedDate: today },
      `${e.key}.mgmtDashboard.summary(all)`))
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

  return results
}

await runSmoke('smoke-rbac-hq-level', run, async () => {
  await cleanupTestData(NS)
  await closePool()
})
