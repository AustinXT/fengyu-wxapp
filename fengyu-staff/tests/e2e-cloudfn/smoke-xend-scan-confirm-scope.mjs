#!/usr/bin/env bun
/**
 * 跨端 staff + client 链：店长 confirmOffline 扣储值卡 → 顾客 card.history 可见
 *
 * 完整链路：
 *   1. 顾客（client_wechat_users）已绑 A1 店 + 储值卡余额 1000
 *   2. 店长（manager@A1）创建一笔 prepaid_card_amount=300 的待确认收款单
 *   3. **staffApi.order.confirmOffline** → 扣储值卡 + 写 card_transactions(type='扣款')
 *   4. **clientApi.card.history**（用顾客 _testOpenid）→ 应能查到刚才那笔扣款记录
 *
 * 还顺带测一个"反向边界"：
 *   5. B 市场经理调 order.confirmOffline 同一笔单 → 拒绝（订单不在其 scope 内）
 */
import './setup.mjs'
import {
  NS, TEST_MARKETS, TEST_STORES_MULTI, closePool, testPhone, pgQuery,
} from './setup.mjs'
import {
  createTestOrg, createTestStaffWithRoles, createTestClient, createTestSaleOrder,
  createTestPrepaidCard, cleanupTestData, invalidateStaffAuthCache,
} from './helpers/fixtures.mjs'
import { invokeStaffApi, invokeClientApi } from './helpers/invoke.mjs'
import { runSmoke } from './helpers/rbac-asserts.mjs'

async function run() {
  await cleanupTestData(NS)
  await createTestOrg({ markets: ['A', 'B'], stores: ['A1', 'A2', 'B1', 'B2'] })

  const S_A1 = TEST_STORES_MULTI.A1
  const MGR_A1 = { empId: `${NS}_XEND_SC_MGR`, oid: `${NS}_XEND_SC_MGR_OID`, phone: testPhone(3) }
  const MGR_MB = { empId: `${NS}_XEND_SC_MMB`, oid: `${NS}_XEND_SC_MMB_OID`, phone: testPhone(4) }

  await createTestStaffWithRoles({
    employeeId: MGR_A1.empId, openid: MGR_A1.oid, phone: MGR_A1.phone, name: `${NS}_A1店长`,
    storeId: S_A1.storeId, orgNodeId: S_A1.orgId,
    bindings: [{ role: 'manager', scopeId: S_A1.orgId }],
  })
  await createTestStaffWithRoles({
    employeeId: MGR_MB.empId, openid: MGR_MB.oid, phone: MGR_MB.phone, name: `${NS}_B市场经理`,
    storeId: TEST_STORES_MULTI.B1.storeId, orgNodeId: TEST_STORES_MULTI.B1.orgId,
    bindings: [{ role: 'manager', scopeId: TEST_MARKETS.B.orgId }],
  })

  // 顾客 + 储值卡（初始 1000）
  const CLI_ID = `${NS}_XEND_SC_CLI`
  const CLI_OID = `${NS}_XEND_SC_CLI_OID`
  await createTestClient({
    userId: CLI_ID, openid: CLI_OID, phone: testPhone(5),
    boundStoreId: S_A1.storeId, pointsBalance: 0,
  })
  const { cardId } = await createTestPrepaidCard({ userId: CLI_ID, initialBalance: 1000 })

  // 待确认收款单（prepaid_card_amount=300，total=300，paid=0）
  const ORDER = `${NS}_XEND_SC_O1`
  await createTestSaleOrder({
    saleOrderId: ORDER, clientUserId: CLI_ID, storeId: S_A1.storeId,
    openedBy: MGR_A1.empId, totalAmount: 300, status: '待支付',
    paymentMethod: '储值卡', prepaidCardAmount: 300,
  })

  await invalidateStaffAuthCache([MGR_A1.oid, MGR_MB.oid])
  await pgQuery(`SELECT 1`)

  const results = []

  // 1) 反向边界：B 市场经理调 confirmOffline → 拒绝
  const denyR = await invokeStaffApi('order.confirmOffline', {
    _testOpenid: MGR_MB.oid, _loginLevel: 'store', _currentStoreId: TEST_STORES_MULTI.B1.storeId,
    saleOrderId: ORDER,
  })
  if (denyR.code === 0) {
    results.push({ ok: false, label: 'cross-market.confirmOffline.deny', reason: `应拒绝但 code=0` })
  } else {
    results.push({ ok: true, label: `cross-market.confirmOffline.deny (errorType=${denyR.errorType})` })
  }

  // 2) A1 店长 confirmOffline → 扣储值卡
  const confirmR = await invokeStaffApi('order.confirmOffline', {
    _testOpenid: MGR_A1.oid, saleOrderId: ORDER,
  })
  if (confirmR.code !== 0) {
    results.push({ ok: false, label: 'staff.confirmOffline', reason: `code=${confirmR.code} ${confirmR.message}` })
    return results
  }
  results.push({ ok: true, label: 'staff.confirmOffline OK' })

  // 3) staff 视角验证：储值卡余额 = 700
  const cards = await pgQuery(
    `SELECT balance FROM prepaid_cards WHERE card_id = $1`, [cardId]
  )
  const newBalance = Number(cards[0]?.balance)
  if (newBalance !== 700) {
    results.push({ ok: false, label: 'staff.balance', reason: `expected 700, got ${newBalance}` })
  } else {
    results.push({ ok: true, label: 'staff.prepaid_card.balance=700 (1000-300)' })
  }

  // 4) client 端 card.history（用顾客 _testOpenid） → 看到扣款流水
  const histR = await invokeClientApi('card.history', {
    _testOpenid: CLI_OID, cardId, page: 1, pageSize: 20,
  })
  if (histR.code !== 0) {
    results.push({ ok: false, label: 'client.card.history', reason: `code=${histR.code} ${histR.message}` })
  } else {
    const list = histR.data?.records || histR.data?.list || histR.data || []
    const deduct = (Array.isArray(list) ? list : []).find(
      (t) => (t.type === '扣款' || t.changeType === '扣款') && Number(t.amount) === -300
    ) || (Array.isArray(list) ? list : []).find(
      (t) => t.ref_order_id === ORDER || t.refOrderId === ORDER
    )
    if (!deduct) {
      const sample = JSON.stringify(list).slice(0, 200)
      results.push({ ok: false, label: 'client.card.history.contains.deduct', reason: `not found in ${list.length} rows; sample=${sample}` })
    } else {
      results.push({ ok: true, label: 'client.card.history: 顾客可见 staff confirmOffline 触发的扣款流水' })
    }
  }

  return results
}

await runSmoke('smoke-xend-scan-confirm-scope', run, async () => {
  await cleanupTestData(NS)
  await closePool()
})
