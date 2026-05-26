#!/usr/bin/env bun
/**
 * mgmtProduct 三视角 smoke（替换原 TODO 版本）
 *
 * 覆盖 mgmtProduct.cardHolders + cycleStats × 3 种 scope（all/market/store）。
 * 重点：scope 切换都能成功返回，不强金额断言。
 */
import './setup.mjs'
import {
  NS, TEST_HQ_ORG_ID, TEST_MARKETS, TEST_STORES_MULTI, closePool, testPhone, pgQuery,
} from './setup.mjs'
import {
  createTestOrg, createTestStaffWithRoles,
  cleanupTestData, invalidateStaffAuthCache,
} from './helpers/fixtures.mjs'
import { expectOk, expectFail, runSmoke } from './helpers/rbac-asserts.mjs'

async function run() {
  await cleanupTestData(NS)
  await createTestOrg({ markets: ['A', 'B'], stores: ['A1', 'A2', 'B1', 'B2'] })

  const FIN_HQ = { empId: `${NS}_MGMT_P_FIN_HQ`, oid: `${NS}_MGMT_P_FIN_HQ_OID`, phone: testPhone(3) }
  const FIN_MA = { empId: `${NS}_MGMT_P_FIN_MA`, oid: `${NS}_MGMT_P_FIN_MA_OID`, phone: testPhone(4) }

  await createTestStaffWithRoles({
    employeeId: FIN_HQ.empId, openid: FIN_HQ.oid, phone: FIN_HQ.phone, name: `${NS}_HQ`,
    storeId: TEST_STORES_MULTI.A1.storeId, orgNodeId: TEST_STORES_MULTI.A1.orgId,
    bindings: [{ role: 'finance', scopeId: TEST_HQ_ORG_ID }],
  })
  await createTestStaffWithRoles({
    employeeId: FIN_MA.empId, openid: FIN_MA.oid, phone: FIN_MA.phone, name: `${NS}_A市场`,
    storeId: TEST_STORES_MULTI.A1.storeId, orgNodeId: TEST_STORES_MULTI.A1.orgId,
    bindings: [{ role: 'finance', scopeId: TEST_MARKETS.A.orgId }],
  })

  await invalidateStaffAuthCache([FIN_HQ.oid, FIN_MA.oid])
  await pgQuery(`SELECT 1`)

  const results = []
  const scopes = [
    { name: 'all',      payload: { scopeType: 'all' } },
    { name: 'market_A', payload: { scopeType: 'market', scopeId: TEST_MARKETS.A.orgId } },
    { name: 'store_A1', payload: { scopeType: 'store',  scopeId: TEST_STORES_MULTI.A1.storeId } },
  ]
  for (const s of scopes) {
    results.push(await expectOk('mgmtProduct.cardHolders',
      { _testOpenid: FIN_HQ.oid, _loginLevel: 'management', ...s.payload },
      `HQ.cardHolders.${s.name}`))
    results.push(await expectOk('mgmtProduct.cycleStats',
      { _testOpenid: FIN_HQ.oid, _loginLevel: 'management', period: 'month', ...s.payload },
      `HQ.cycleStats.${s.name}`))
  }

  // 越市场拒绝
  results.push(await expectFail('mgmtProduct.cardHolders',
    {
      _testOpenid: FIN_MA.oid, _loginLevel: 'management',
      scopeType: 'market', scopeId: TEST_MARKETS.B.orgId,
    },
    'PERMISSION_DENIED',
    'market_A.cardHolders.market_B → 越市场'))

  return results
}

await runSmoke('smoke-mgmt-product', run, async () => {
  await cleanupTestData(NS)
  await closePool()
})
