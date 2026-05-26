#!/usr/bin/env bun
/**
 * mgmtCustomer scope 隔离 smoke（替换原 TODO 版本）
 *
 * fixture：2 市场（A/B）× 各 2 门店 + 4 个顾客分别绑 4 个门店
 *
 * 验证矩阵（mgmtCustomer.search 的 keyword=NS 前缀，按 bound_store_id 过滤）：
 *   - finance@HQ, scopeType='all'                → 4 顾客都可见
 *   - finance@HQ, scopeType='market', scopeId=A  → 仅 2 顾客（A1+A2 顾客）
 *   - finance@HQ, scopeType='store', scopeId=A1  → 仅 1 顾客（A1 顾客）
 *   - finance@market_A, scopeType='all'          → PERMISSION_DENIED（市场账号不能 all）
 *   - finance@market_A, scopeType='market'=B     → PERMISSION_DENIED（越市场）
 *   - finance@market_A, scopeType='market'=A     → 仅 2 顾客（A1+A2）
 *
 * 加 mgmtCustomer.detail 跨市场拒绝 1 项。
 */
import './setup.mjs'
import {
  NS, TEST_HQ_ORG_ID, TEST_MARKETS, TEST_STORES_MULTI, closePool, testPhone,
} from './setup.mjs'
import {
  createTestOrg, createTestStaffWithRoles, createTestClient,
  cleanupTestData, invalidateStaffAuthCache,
} from './helpers/fixtures.mjs'
import { invokeStaffApi } from './helpers/invoke.mjs'
import { expectFail, runSmoke } from './helpers/rbac-asserts.mjs'

async function run() {
  await cleanupTestData(NS)
  await createTestOrg({ markets: ['A', 'B'], stores: ['A1', 'A2', 'B1', 'B2'] })

  // 4 个顾客分别绑 4 个门店
  const clients = []
  for (const k of ['A1', 'A2', 'B1', 'B2']) {
    const s = TEST_STORES_MULTI[k]
    const userId = `${NS}_MGMT_CLI_${k}`
    await createTestClient({
      userId, openid: `${NS}_MGMT_CLI_${k}_OID`,
      phone: testPhone(10 + ['A1', 'A2', 'B1', 'B2'].indexOf(k)),
      boundStoreId: s.storeId,
    })
    clients.push({ key: k, userId, storeKey: k })
  }

  // 测试员工：finance@HQ + finance@market_A
  const FIN_HQ = { empId: `${NS}_MGMT_FIN_HQ`, oid: `${NS}_MGMT_FIN_HQ_OID`, phone: testPhone(3) }
  const FIN_MA = { empId: `${NS}_MGMT_FIN_MA`, oid: `${NS}_MGMT_FIN_MA_OID`, phone: testPhone(4) }

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

  // 等待 PG 连接池稳定（前置 cleanup + 多笔 insert 后立即查询偶发 0 rows，
  // 加一笔轻量 SELECT 作为屏障让 staffApi 第一次 require 拉到最新数据）
  const { pgQuery } = await import('./setup.mjs')
  await pgQuery(`SELECT 1`)

  const results = []

  // 公共调用包装：返回顾客 user_id 集合，过滤只取本次 fixture 的 NS_MGMT_CLI_*
  async function searchByScope(openid, scopeType, scopeId) {
    const r = await invokeStaffApi('mgmtCustomer.search', {
      _testOpenid: openid, _loginLevel: 'management',
      scopeType, scopeId, keyword: NS,
    })
    if (r.code !== 0) return { code: r.code, message: r.message, errorType: r.errorType }
    const list = r.data?.customers || []
    return { code: 0, userIds: list.map((c) => c.clientUserId).filter(Boolean) }
  }

  // 1) finance@HQ × scopeType=all → 应见 4 顾客
  let r = await searchByScope(FIN_HQ.oid, 'all', null)
  if (r.code !== 0) results.push({ ok: false, label: 'HQ.all', reason: `code=${r.code} ${r.message}` })
  else {
    const visible = clients.filter((c) => r.userIds.includes(c.userId))
    if (visible.length !== 4) {
      results.push({
        ok: false, label: 'HQ.all',
        reason: `expected 4 visible, got ${visible.length} (${JSON.stringify(r.userIds)})`,
      })
    } else results.push({ ok: true, label: 'HQ.all visible 4/4' })
  }

  // 2) finance@HQ × scopeType=market_A → 仅 A1+A2 = 2 顾客
  r = await searchByScope(FIN_HQ.oid, 'market', TEST_MARKETS.A.orgId)
  if (r.code !== 0) results.push({ ok: false, label: 'HQ.market_A', reason: `${r.code} ${r.message}` })
  else {
    const visible = clients.filter((c) => r.userIds.includes(c.userId)).map((c) => c.key).sort()
    if (visible.join(',') !== 'A1,A2') {
      results.push({ ok: false, label: 'HQ.market_A', reason: `expected [A1,A2], got [${visible.join(',')}]` })
    } else results.push({ ok: true, label: 'HQ.market_A → [A1,A2]' })
  }

  // 3) finance@HQ × scopeType=store_A1 → 仅 A1
  r = await searchByScope(FIN_HQ.oid, 'store', TEST_STORES_MULTI.A1.storeId)
  if (r.code !== 0) results.push({ ok: false, label: 'HQ.store_A1', reason: `${r.code} ${r.message}` })
  else {
    const visible = clients.filter((c) => r.userIds.includes(c.userId)).map((c) => c.key).sort()
    if (visible.join(',') !== 'A1') {
      results.push({ ok: false, label: 'HQ.store_A1', reason: `expected [A1], got [${visible.join(',')}]` })
    } else results.push({ ok: true, label: 'HQ.store_A1 → [A1]' })
  }

  // 4) finance@market_A × scopeType=all → 403
  results.push(await expectFail('mgmtCustomer.search',
    { _testOpenid: FIN_MA.oid, _loginLevel: 'management', scopeType: 'all' },
    'PERMISSION_DENIED',
    'market_A.scopeType=all'))

  // 5) finance@market_A × scopeType=market_B → 403
  results.push(await expectFail('mgmtCustomer.search',
    { _testOpenid: FIN_MA.oid, _loginLevel: 'management', scopeType: 'market', scopeId: TEST_MARKETS.B.orgId },
    'PERMISSION_DENIED',
    'market_A.scopeType=market_B'))

  // 6) finance@market_A × scopeType=market_A → A1+A2
  r = await searchByScope(FIN_MA.oid, 'market', TEST_MARKETS.A.orgId)
  if (r.code !== 0) results.push({ ok: false, label: 'market_A.market_A', reason: `${r.code} ${r.message}` })
  else {
    const visible = clients.filter((c) => r.userIds.includes(c.userId)).map((c) => c.key).sort()
    if (visible.join(',') !== 'A1,A2') {
      results.push({ ok: false, label: 'market_A.market_A', reason: `expected [A1,A2], got [${visible.join(',')}]` })
    } else results.push({ ok: true, label: 'market_A.market_A → [A1,A2]' })
  }

  // 7) mgmtCustomer.detail 越市场顾客 → 403
  results.push(await expectFail('mgmtCustomer.detail',
    {
      _testOpenid: FIN_MA.oid, _loginLevel: 'management',
      scopeType: 'market', scopeId: TEST_MARKETS.A.orgId,
      clientUserId: clients.find((c) => c.key === 'B1').userId,
    },
    'PERMISSION_DENIED',
    'market_A.detail.B1 → cross-market'))

  return results
}

await runSmoke('smoke-mgmt-customer', run, async () => {
  await cleanupTestData(NS)
  await closePool()
})
