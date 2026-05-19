#!/usr/bin/env bun
/**
 * 多角色多 scope 归并 smoke
 *
 * 覆盖归并优先级（utils/scope.js:25-51 deriveStaffLevel）：
 *   - 任何 + 总部 → headquarters（取最高）
 *   - 任何 + 市场 → market（无总部时）
 *   - manager + 门店 → store_manager（无总部/市场时）
 *   - 其他 + 门店 → store_staff
 *
 * 用例（同一员工绑多个 binding）：
 *   1. (manager, A1) + (finance, market_A)        → market   （市场层覆盖门店层）
 *   2. (manager, A1) + (manager, A2)              → store_manager + scopeStoreIds=[A1,A2]
 *   3. (manager, market_A) + (manager, market_B)  → market + scopeStoreIds=[A1,A2,B1,B2]
 *   4. (finance, HQ) + (manager, A1)              → headquarters（HQ 覆盖一切）
 *   5. (finance, A1) + (customer_mgr, A2)         → store_staff + scopeStoreIds=[A1,A2]（多店非 manager）
 */
import './setup.mjs'
import {
  NS, pgQuery, TEST_HQ_ORG_ID, TEST_MARKETS, TEST_STORES_MULTI, closePool, testPhone,
} from './setup.mjs'
import {
  createTestOrg, createTestStaffWithRoles, cleanupTestData, invalidateStaffAuthCache,
} from './helpers/fixtures.mjs'
import { invokeStaffApi } from './helpers/invoke.mjs'
import { runSmoke } from './helpers/rbac-asserts.mjs'

const cases = [
  {
    key: 'mgr@A1+fin@mktA',
    bindings: () => [
      { role: 'manager', scopeId: TEST_STORES_MULTI.A1.orgId },
      { role: 'finance', scopeId: TEST_MARKETS.A.orgId },
    ],
    expectLevel: 'market',
    expectStores: ['A1', 'A2'],
  },
  {
    key: 'mgr@A1+mgr@A2',
    bindings: () => [
      { role: 'manager', scopeId: TEST_STORES_MULTI.A1.orgId },
      { role: 'manager', scopeId: TEST_STORES_MULTI.A2.orgId },
    ],
    expectLevel: 'store_manager',
    expectStores: ['A1', 'A2'],
  },
  {
    key: 'mgr@mktA+mgr@mktB',
    bindings: () => [
      { role: 'manager', scopeId: TEST_MARKETS.A.orgId },
      { role: 'manager', scopeId: TEST_MARKETS.B.orgId },
    ],
    expectLevel: 'market',
    expectStores: ['A1', 'A2', 'B1', 'B2'],
  },
  {
    key: 'fin@HQ+mgr@A1',
    bindings: () => [
      { role: 'finance', scopeId: TEST_HQ_ORG_ID },
      { role: 'manager', scopeId: TEST_STORES_MULTI.A1.orgId },
    ],
    expectLevel: 'headquarters',
    expectStoresAtLeast: 4, // 全量门店（含我们 4 个测试店）
  },
  {
    key: 'fin@A1+cm@A2',
    bindings: () => [
      { role: 'finance', scopeId: TEST_STORES_MULTI.A1.orgId },
      { role: 'customer_mgr', scopeId: TEST_STORES_MULTI.A2.orgId },
    ],
    expectLevel: 'store_staff',
    expectStores: ['A1', 'A2'],
  },
]

async function run() {
  await cleanupTestData(NS)
  await createTestOrg({ markets: ['A', 'B'], stores: ['A1', 'A2', 'B1', 'B2'] })

  const employees = cases.map((c, i) => ({
    ...c,
    empId: `${NS}_RBAC_MB_${i + 1}`,
    oid: `${NS}_RBAC_MB_${i + 1}_OPENID`,
    phone: testPhone(3 + i),
  }))

  for (const e of employees) {
    await createTestStaffWithRoles({
      employeeId: e.empId, openid: e.oid, phone: e.phone, name: `${NS}_多绑定_${e.key}`,
      storeId: TEST_STORES_MULTI.A1.storeId, orgNodeId: TEST_STORES_MULTI.A1.orgId,
      bindings: e.bindings(),
    })
  }
  await invalidateStaffAuthCache(employees.map((e) => e.oid))
  await pgQuery(`SELECT 1`) // PG 连接池屏障

  const results = []
  for (const e of employees) {
    const r = await invokeStaffApi('auth.login', { _testOpenid: e.oid })
    if (r.code !== 0) {
      results.push({ ok: false, label: `login.${e.key}`, reason: `code=${r.code} ${r.message}` })
      continue
    }

    const lvl = r.data?.staffLevel
    const scopedIds = (r.data?.scopedStores || []).map((s) => s.storeId).sort()

    if (lvl !== e.expectLevel) {
      results.push({ ok: false, label: `${e.key}.staffLevel`, reason: `expected=${e.expectLevel}, got=${lvl}` })
      continue
    }

    if (e.expectStoresAtLeast) {
      if (scopedIds.length < e.expectStoresAtLeast) {
        results.push({ ok: false, label: `${e.key}.scopedStores`, reason: `expected ≥ ${e.expectStoresAtLeast}, got=${scopedIds.length}` })
        continue
      }
    } else if (e.expectStores) {
      const expectStoreIds = e.expectStores.map((k) => TEST_STORES_MULTI[k].storeId).sort()
      const matched = expectStoreIds.every((id) => scopedIds.includes(id))
      if (!matched || scopedIds.length !== expectStoreIds.length) {
        results.push({
          ok: false, label: `${e.key}.scopedStores`,
          reason: `expected=${JSON.stringify(expectStoreIds)}, got=${JSON.stringify(scopedIds)}`,
        })
        continue
      }
    }

    results.push({ ok: true, label: `${e.key}: ${lvl} + ${scopedIds.length} stores` })
  }

  return results
}

await runSmoke('smoke-rbac-multi-binding', run, async () => {
  await cleanupTestData(NS)
  await closePool()
})
