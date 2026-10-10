#!/usr/bin/env bun
// #553：真实云函数 handler + PostgreSQL，类别只分组，资格只看已售体验快照。
import './setup.mjs'
import { NS, TEST_HQ_ORG_ID, TEST_MARKETS, TEST_STORES_MULTI, closePool, testPhone, pgQuery } from './setup.mjs'
import { createTestOrg, createTestStaffWithRoles, cleanupTestData, invalidateStaffAuthCache } from './helpers/fixtures.mjs'
import { invokeStaffApi } from './helpers/invoke.mjs'
import { runSmoke } from './helpers/rbac-asserts.mjs'

async function run() {
  await cleanupTestData(NS)
  await createTestOrg({ markets: ['A'], stores: ['A1'] })
  const manager = { id: `${NS}_553_FIN`, openid: `${NS}_553_OID` }
  await createTestStaffWithRoles({
    employeeId: manager.id, openid: manager.openid, phone: testPhone(3), name: `${NS}_553财务`,
    storeId: TEST_STORES_MULTI.A1.storeId, orgNodeId: TEST_STORES_MULTI.A1.orgId,
    bindings: [{ role: 'finance', scopeId: TEST_HQ_ORG_ID }],
  })
  await invalidateStaffAuthCache([manager.openid])
  const store = TEST_STORES_MULTI.A1.storeId
  const date = (await pgQuery('SELECT CURRENT_DATE::text AS date'))[0].date
  for (const [key, type, amount, items] of [
    ['P', '销售单', 100, [['拓客引流卡', false, 100]]],
    ['T', '销售单', 50, [['拓客引流卡', true, 50]]],
    ['O', '销售单', 30, [['王牌', true, 30]]],
    ['C', '转换单', 5000, [['拓客引流卡', false, -168], ['王牌', false, 5168]]],
  ]) {
    const order = `${NS}_553_${key}`
    await pgQuery(`INSERT INTO sale_orders(sale_order_id,market_name,store_id,sale_order_datetime,
      total_amount,received,payment_method,status,sale_order_type,performance_attribution_date)
      VALUES ($1,'测试市场',$2,$5::date + TIME '12:00:00',$3,$3,'线下','已支付',$4,$5::date)`, [order, store, amount, type, date])
    const rows = await pgQuery(`INSERT INTO sale_order_payments(sale_order_id,change_type,amount,
      payment_method,status,source_end,paid_at) VALUES ($1,'首次支付',$2,'线下','已支付','staff',$3::date + TIME '12:00:00') RETURNING id`, [order, amount, date])
    for (let i = 0; i < items.length; i++) {
      const [kind, trial, value] = items[i], id = `${order}_${i}`
      await pgQuery(`INSERT INTO sale_items(sale_item_id,sale_order_id,store_id,product_type,item_direction,
        unit_price,unit_real_price,sale_amount,received,is_shengmei,is_experience,product_kind_at_sale)
        VALUES ($1,$2,$3,'疗程卡',$4,ABS($5::numeric),ABS($5::numeric),$5,$5,true,$6,$7)`,
      [id, order, store, value < 0 ? '转出' : '购买', value, trial, kind])
      const receiptRows = await pgQuery(`INSERT INTO sale_payment_item_receipts(sale_payment_id,sale_order_id,sale_item_id,amount)
        VALUES ($1,$2,$3,$4) RETURNING id`, [rows[0].id, order, id, value])
      if (key === 'P' || key === 'T') {
        await pgQuery(`INSERT INTO sale_payment_item_allocations(sale_payment_item_receipt_id,employee_id,
          role_type,allocation_ratio,allocated_amount,commission_rate,commission_amount)
          VALUES ($1,$2,'美容师',1,$3,0.1,$4)`, [receiptRows[0].id, manager.id, value, value / 10])
      }
    }
  }
  const results = []
  for (const scope of [
    { scopeType: 'all' }, { scopeType: 'market', scopeId: TEST_MARKETS.A.orgId },
    { scopeType: 'store', scopeId: store },
  ]) {
    const r = await invokeStaffApi('mgmtDashboard.summary', {
      ...scope, date, _testOpenid: manager.openid, _loginLevel: 'management',
    })
    results.push({ ok: r.code === 0 && r.data?.storeRevenue?.month === 5100 && r.data?.shengmeiRevenue?.month === 5100,
      label: `${scope.scopeType}: 非体验粉红 + 正负转换 = 5100`,
      reason: `code=${r.code}, cash=${r.data?.storeRevenue?.month}, shengmei=${r.data?.shengmeiRevenue?.month}` })
  }
  for (const [metric, expected] of [['revenue', 100], ['income', 15]]) {
    const r = await invokeStaffApi('mgmtDashboard.staffRanking', {
      period: 'month', metric, _testOpenid: manager.openid, _loginLevel: 'management',
    })
    const row = r.data?.rows?.find(x => x.employeeId === manager.id)
    results.push({ ok: r.code === 0 && Number(row?.value) === expected,
      label: `员工业绩/应发提成独立：${metric}=${expected}`, reason: `code=${r.code}, value=${row?.value}` })
  }
  const rows = await pgQuery(`SELECT SUM(amount)::text AS total FROM sale_order_payments WHERE sale_order_id LIKE $1`, [`${NS}_553_%`])
  results.push({ ok: Number(rows[0].total) === 5180, label: '资金事实 5180 保留，业绩资格不改写原款项' })
  return results
}
await runSmoke('smoke-experience-performance', run, async () => { await cleanupTestData(NS); await closePool() })
