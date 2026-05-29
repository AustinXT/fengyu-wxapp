#!/usr/bin/env bun
/**
 * mgmtDashboard 三视角 smoke（新增）
 *
 * fixture：2 市场 × 各 2 门店 + 1 个 finance@HQ + 1 个 finance@market_A
 *
 * 验证 4 个 action × 3 种 scope：
 *   1. mgmtDashboard.scopeOptions       → HQ 返回 staffLevel='headquarters' + ≥2 markets
 *                                          market_A 返回 staffLevel='market' + 1 market（A）
 *   2. mgmtDashboard.summary            → 三种 scope（all / market / store）都 code=0
 *   3. mgmtDashboard.storeRanking       → 同
 *   4. mgmtDashboard.staffRanking       → 同
 *
 * 重点：scope 切换都能成功返回，不强金额断言（金额需 sale_allocations 真实数据，不在本轮 fixture 范围）
 */
import './setup.mjs'
import {
  NS, TEST_HQ_ORG_ID, TEST_MARKETS, TEST_STORES_MULTI, closePool, testPhone, pgQuery,
} from './setup.mjs'
import {
  createTestOrg, createTestStaffWithRoles,
  cleanupTestData, invalidateStaffAuthCache,
} from './helpers/fixtures.mjs'
import { invokeStaffApi } from './helpers/invoke.mjs'
import { expectOk, runSmoke } from './helpers/rbac-asserts.mjs'

async function run() {
  await cleanupTestData(NS)
  await createTestOrg({ markets: ['A', 'B'], stores: ['A1', 'A2', 'B1', 'B2'] })

  const FIN_HQ = { empId: `${NS}_MGMT_D_FIN_HQ`, oid: `${NS}_MGMT_D_FIN_HQ_OID`, phone: testPhone(3) }
  const FIN_MA = { empId: `${NS}_MGMT_D_FIN_MA`, oid: `${NS}_MGMT_D_FIN_MA_OID`, phone: testPhone(4) }

  await createTestStaffWithRoles({
    employeeId: FIN_HQ.empId, openid: FIN_HQ.oid, phone: FIN_HQ.phone, name: `${NS}_HQ财务`,
    storeId: TEST_STORES_MULTI.A1.storeId, orgNodeId: TEST_STORES_MULTI.A1.orgId,
    bindings: [{ role: 'finance', scopeId: TEST_HQ_ORG_ID }],
  })
  await createTestStaffWithRoles({
    employeeId: FIN_MA.empId, openid: FIN_MA.oid, phone: FIN_MA.phone, name: `${NS}_A市场财务`,
    storeId: TEST_STORES_MULTI.A1.storeId, orgNodeId: TEST_STORES_MULTI.A1.orgId,
    bindings: [{ role: 'finance', scopeId: TEST_MARKETS.A.orgId }],
  })

  await invalidateStaffAuthCache([FIN_HQ.oid, FIN_MA.oid])
  await pgQuery(`SELECT 1`) // PG 连接池屏障

  const today = new Date().toISOString().slice(0, 10)
  const results = []

  // 1) scopeOptions：HQ 看到 ≥2 markets；market_A 看到 1 market
  const sOptHQ = await invokeStaffApi('mgmtDashboard.scopeOptions',
    { _testOpenid: FIN_HQ.oid, _loginLevel: 'management' })
  if (sOptHQ.code !== 0 || sOptHQ.data?.staffLevel !== 'headquarters' || !(sOptHQ.data?.markets?.length >= 2)) {
    results.push({
      ok: false, label: 'HQ.scopeOptions',
      reason: `code=${sOptHQ.code} staffLevel=${sOptHQ.data?.staffLevel} markets=${sOptHQ.data?.markets?.length}`,
    })
  } else {
    results.push({ ok: true, label: `HQ.scopeOptions: hq×${sOptHQ.data.markets.length}markets` })
  }

  const sOptMA = await invokeStaffApi('mgmtDashboard.scopeOptions',
    { _testOpenid: FIN_MA.oid, _loginLevel: 'management' })
  if (sOptMA.code !== 0 || sOptMA.data?.staffLevel !== 'market') {
    results.push({ ok: false, label: 'market_A.scopeOptions', reason: `code=${sOptMA.code} staffLevel=${sOptMA.data?.staffLevel}` })
  } else {
    const visibleMktIds = (sOptMA.data?.markets || []).map((m) => m.id)
    if (visibleMktIds.length !== 1 || visibleMktIds[0] !== TEST_MARKETS.A.orgId) {
      results.push({
        ok: false, label: 'market_A.scopeOptions.markets',
        reason: `expected [A], got ${JSON.stringify(visibleMktIds)}`,
      })
    } else {
      results.push({ ok: true, label: 'market_A.scopeOptions: market×[A only]' })
    }
  }

  // 2-4) summary / storeRanking / staffRanking — 三种 scope 都 code=0
  const scopes = [
    { name: 'all',         payload: { scopeType: 'all' } },
    { name: 'market_A',    payload: { scopeType: 'market', scopeId: TEST_MARKETS.A.orgId } },
    { name: 'store_A1',    payload: { scopeType: 'store',  scopeId: TEST_STORES_MULTI.A1.storeId } },
  ]
  for (const s of scopes) {
    results.push(await expectOk('mgmtDashboard.summary',
      { _testOpenid: FIN_HQ.oid, _loginLevel: 'management', date: today, ...s.payload },
      `HQ.summary.${s.name}`))
    results.push(await expectOk('mgmtDashboard.storeRanking',
      { _testOpenid: FIN_HQ.oid, _loginLevel: 'management', period: 'month', metric: 'revenue', ...s.payload },
      `HQ.storeRanking.${s.name}`))
    results.push(await expectOk('mgmtDashboard.staffRanking',
      { _testOpenid: FIN_HQ.oid, _loginLevel: 'management', period: 'month', metric: 'revenue', ...s.payload },
      `HQ.staffRanking.${s.name}`))
  }

  // 5) salesData × 3 scope（入参格式不同：scope 嵌套 {type, id}，period 'month'|'lastMonth'|'year'）
  const salesScopes = [
    { name: 'all',      payload: { period: 'month', scope: { type: 'all' } } },
    { name: 'market_A', payload: { period: 'month', scope: { type: 'market', id: TEST_MARKETS.A.orgId } } },
    { name: 'store_A1', payload: { period: 'month', scope: { type: 'store',  id: TEST_STORES_MULTI.A1.storeId } } },
  ]
  for (const s of salesScopes) {
    const sdR = await invokeStaffApi('mgmtDashboard.salesData',
      { _testOpenid: FIN_HQ.oid, _loginLevel: 'management', ...s.payload })
    if (sdR.code !== 0) {
      results.push({ ok: false, label: `HQ.salesData.${s.name}`, reason: `code=${sdR.code} msg=${sdR.message}` })
    } else {
      // routes/mgmt-dashboard.js:1303 返回 totalRevenue / 分客型业绩 / totalConsume / 品项汇总 等
      const d = sdR.data || {}
      const required = ['totalRevenue', 'totalConsume']
      const missing = required.filter(k => !(k in d))
      if (missing.length) {
        results.push({ ok: false, label: `HQ.salesData.${s.name}`, reason: `缺字段 ${missing.join(',')}` })
      } else {
        results.push({ ok: true, label: `HQ.salesData.${s.name}: totalRevenue=${d.totalRevenue}` })
      }
    }
  }

  // 6) 入参非法分支：未知 period → INVALID_PARAMS
  const badPeriod = await invokeStaffApi('mgmtDashboard.salesData',
    { _testOpenid: FIN_HQ.oid, _loginLevel: 'management', period: 'week', scope: { type: 'all' } })
  if (badPeriod.code === 0) {
    results.push({ ok: false, label: 'salesData.invalidPeriod', reason: '应 INVALID_PARAMS' })
  } else {
    results.push({ ok: true, label: `salesData.invalidPeriod → ${badPeriod.message}` })
  }

  return results
}

await runSmoke('smoke-mgmt-dashboard', run, async () => {
  await cleanupTestData(NS)
  await closePool()
})
