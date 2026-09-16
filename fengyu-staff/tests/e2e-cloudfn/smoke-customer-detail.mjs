#!/usr/bin/env bun
/**
 * customer.detail + appointments + phoneChangeLogs 冒烟（顾客档案 Tab 端到端）
 *
 * 验证：
 *   1. detail 返回 7 项关键字段（gender/storeName/notes/lastServiceDate/visitFrequency/topProductName + memberLevel）
 *   2. customer.appointments — 按 clientUserId 拉预约 + sale_items JOIN + scope 过滤
 *   3. customer.phoneChangeLogs — 查 operation_logs(action='auth.rebindPhone' OR 'customer.update' + detail.changes 含 phone)
 */
import './setup.mjs'
import {
  NS, TEST_STORE_ID, TEST_MANAGER_OPENID, TEST_MANAGER_EMP_ID, TEST_CLIENT_USER_ID, pgQuery, closePool,
} from './setup.mjs'
import { invokeStaffApi } from './helpers/invoke.mjs'
import {
  ensureTestStore, createTestStaff, createTestClient, createTestSaleOrder, createTestAppointment,
  cleanupTestData,
} from './helpers/fixtures.mjs'

let pass = false; let exitCode = 1
function rec(line) { console.log(line) }

async function main() {
  rec(`[smoke-customer-detail] start`)
  await cleanupTestData(NS)
  await ensureTestStore()
  await createTestStaff()
  await createTestClient()

  // 消费口径夹具（#141 起按**业绩归属日期**落年，非 paid_at）：
  // - WorkFine 历史销售单无支付流水，继续按订单快照计入（legacy 分支走订单级归属日）；
  // - 原生部分支付按款项归属日计入本年；
  // - 跨年结清订单：**首次支付按订单归属日落年**（0039 trigger 镜像，即使 paid_at 在去年
  //   也计入今年），回款按款项自身归属日落年 —— 这条正是新旧口径的分水岭
  //   （旧 paid_at 口径会排除那笔首次支付 → 1700，新口径计入 → 1900）；
  // - 寄存单只是剩余权益初始化，不重复计入。
  const legacySaleOrderId = `${NS}_CUSDET_SALE`
  const partialOrderId = `${NS}_CUSDET_PARTIAL`
  const crossYearOrderId = `${NS}_CUSDET_CROSS_YEAR`
  const depositOrderId = `${NS}_CUSDET_DEP`
  await createTestSaleOrder({
    saleOrderId: legacySaleOrderId,
    clientUserId: TEST_CLIENT_USER_ID,
    totalAmount: 1200,
    status: '已支付',
    saleOrderType: '销售单',
  })
  await pgQuery('DELETE FROM sale_items WHERE sale_order_id = $1', [legacySaleOrderId])
  await pgQuery(
    `UPDATE sale_orders
        SET received = 1200, paid_at = NOW(), legacy_source = 'workfine'
      WHERE sale_order_id = $1`,
    [legacySaleOrderId],
  )
  await createTestSaleOrder({
    saleOrderId: partialOrderId,
    clientUserId: TEST_CLIENT_USER_ID,
    totalAmount: 1000,
    status: '部分支付',
    saleOrderType: '销售单',
  })
  await pgQuery(
    `UPDATE sale_orders
        SET received = 200, paid_at = NULL
      WHERE sale_order_id = $1`,
    [partialOrderId],
  )
  await pgQuery(
    'UPDATE sale_items SET received = 200 WHERE sale_order_id = $1',
    [partialOrderId],
  )
  await pgQuery(
    `INSERT INTO sale_order_payments
       (sale_order_id, change_type, amount, payment_method, status,
        source_end, operator_employee_id, paid_at)
     VALUES ($1, '首次支付', 200, '线下', '已支付', 'staff', $2, NOW())`,
    [partialOrderId, TEST_MANAGER_EMP_ID],
  )

  await createTestSaleOrder({
    saleOrderId: crossYearOrderId,
    clientUserId: TEST_CLIENT_USER_ID,
    totalAmount: 500,
    status: '已支付',
    saleOrderType: '销售单',
  })
  await pgQuery(
    `UPDATE sale_orders
        SET received = 500, paid_at = NOW()
      WHERE sale_order_id = $1`,
    [crossYearOrderId],
  )
  await pgQuery(
    `INSERT INTO sale_order_payments
       (sale_order_id, change_type, amount, payment_method, status,
        source_end, operator_employee_id, paid_at)
     VALUES
       ($1, '首次支付', 200, '线下', '已支付', 'staff', $2,
        (date_trunc('year', NOW() AT TIME ZONE 'Asia/Shanghai') - INTERVAL '1 day') AT TIME ZONE 'Asia/Shanghai'),
       ($1, '回款', 300, '线下', '已支付', 'staff', $2, NOW())`,
    [crossYearOrderId, TEST_MANAGER_EMP_ID],
  )
  await createTestSaleOrder({
    saleOrderId: depositOrderId,
    clientUserId: TEST_CLIENT_USER_ID,
    totalAmount: 800,
    status: '已支付',
    saleOrderType: '寄存单',
  })
  await pgQuery(
    `UPDATE sale_orders
        SET received = 800, paid_at = NOW()
      WHERE sale_order_id = $1`,
    [depositOrderId],
  )

  const errors = []

  // ─── 1. customer.detail ───
  const r = await invokeStaffApi('customer.detail', {
    _testOpenid: TEST_MANAGER_OPENID, clientUserId: TEST_CLIENT_USER_ID,
  })
  if (r.code !== 0) {
    errors.push(`detail code=${r.code} msg=${r.message}`)
  } else {
    const expectedKeys = ['gender', 'storeName', 'notes', 'lastServiceDate', 'visitFrequency', 'topProductName']
    for (const k of expectedKeys) {
      if (!(k in r.data)) errors.push(`detail 缺少字段 ${k}`)
    }
    if (Number(r.data.totalConsumption) !== 1900) {
      errors.push(`detail.totalConsumption 应为历史 1200 + 部分支付 200 + 跨年单 500 = 1900，实际=${r.data.totalConsumption}`)
    }
    // #141：年度消费改按**业绩归属日期**落年。跨年单的首次支付 paid_at 虽在去年，
    // 但 0039 的 BEFORE trigger 把首次支付行的归属日镜像为**订单归属日**（今年），
    // 所以它计入今年 —— 这正是新旧口径的分水岭：旧口径按 paid_at 会排除它（1700），
    // 新口径按归属日会计入（1900）。本断言即新口径已生效的正面证明。
    if (Number(r.data.yearConsumption) !== 1900) {
      errors.push(`detail.yearConsumption 应为历史 1200 + 本年部分支付 200 + 跨年单首次支付 200（归属日镜像订单=今年）+ 本年回款 300 = 1900，实际=${r.data.yearConsumption}`)
    }
    rec(`  ✓ detail 返回字段: gender=${r.data.gender} store=${r.data.storeName} member=${r.data.memberLevel}`)
    rec(`  ✓ 消费口径(#141 归属日): 首次支付按订单归属日计入今年（即使 paid_at 在去年），寄存未重复计入`)
  }

  // 管理层详情必须与门店详情同口径，同时保留无 sale_items 的 WorkFine 历史单回退。
  const mgmtR = await invokeStaffApi('mgmtCustomer.detail', {
    _testOpenid: TEST_MANAGER_OPENID,
    _loginLevel: 'management',
    clientUserId: TEST_CLIENT_USER_ID,
    scopeType: 'store',
    scopeId: TEST_STORE_ID,
  })
  if (mgmtR.code !== 0) {
    errors.push(`mgmtCustomer.detail code=${mgmtR.code} msg=${mgmtR.message}`)
  } else {
    if (Number(mgmtR.data.totalConsumption) !== 1900) {
      errors.push(`mgmtCustomer.detail.totalConsumption 应为 1900，实际=${mgmtR.data.totalConsumption}`)
    }
    if (Number(mgmtR.data.yearConsumption) !== 1900) {
      errors.push(`mgmtCustomer.detail.yearConsumption 应为 1900（同门店详情，#141 归属日口径），实际=${mgmtR.data.yearConsumption}`)
    }
    rec(`  ✓ 管理层详情消费口径与门店详情一致`)
  }

  // ─── 2. customer.appointments — 建 2 条预约后查 ───
  const apptId1 = `${NS}_CUSDET_APT1`
  const apptId2 = `${NS}_CUSDET_APT2`
  await createTestAppointment({
    appointmentId: apptId1,
    status: '待确认',
    clientUserId: TEST_CLIENT_USER_ID,
    appointmentTime: new Date(Date.now() + 60 * 60 * 1000),
    notes: 'e2e_appt_pending',
  })
  await createTestAppointment({
    appointmentId: apptId2,
    status: '已确认',
    clientUserId: TEST_CLIENT_USER_ID,
    appointmentTime: new Date(Date.now() + 2 * 60 * 60 * 1000),
    notes: 'e2e_appt_confirmed',
  })
  const aptR = await invokeStaffApi('customer.appointments', {
    _testOpenid: TEST_MANAGER_OPENID, clientUserId: TEST_CLIENT_USER_ID,
  })
  if (aptR.code !== 0) {
    errors.push(`appointments code=${aptR.code} msg=${aptR.message}`)
  } else {
    const rows = Array.isArray(aptR.data) ? aptR.data : []
    const ids = rows.map(x => x.id || x.appointmentId)
    if (!ids.includes(apptId1) || !ids.includes(apptId2)) {
      errors.push(`appointments 应含 ${apptId1}+${apptId2}，实际 ids=${JSON.stringify(ids)}`)
    } else {
      const a1 = rows.find(x => (x.id || x.appointmentId) === apptId1)
      const a1Required = ['customerName', 'statusText', 'appointmentTime', 'serviceItemName']
      for (const k of a1Required) {
        if (!(k in a1)) errors.push(`appointments[apt1] 缺字段 '${k}'`)
      }
      if (a1.statusText !== '待确认') errors.push(`appointments[apt1].statusText 应='待确认'，实际='${a1.statusText}'`)
      rec(`  ✓ appointments: 含 apt1/apt2，字段齐全`)
    }
  }

  // ─── 3. customer.phoneChangeLogs — 插 2 条 operation_logs 后查 ───
  // 一条 auth.rebindPhone（顾客自助换绑，operator 为空 + detail.clientUserId）
  // 一条 customer.update（admin 后台改 phone，detail.changes.phone={from,to}）
  await pgQuery(
    `INSERT INTO operation_logs (action, target_type, target_id, operator_employee_id, operator_name, detail, source, created_at)
     VALUES ('auth.rebindPhone', 'client_user', $1, NULL, NULL, $2::jsonb, 'client', NOW() - INTERVAL '2 days')`,
    [TEST_CLIENT_USER_ID, JSON.stringify({ clientUserId: TEST_CLIENT_USER_ID, oldPhone: '13800000001', newPhone: '13800000002' })]
  )
  await pgQuery(
    `INSERT INTO operation_logs (action, target_type, target_id, operator_employee_id, operator_name, detail, source, created_at)
     VALUES ('customer.update', 'customer', $1, $2, $3, $4::jsonb, 'admin', NOW() - INTERVAL '1 day')`,
    [TEST_CLIENT_USER_ID, TEST_MANAGER_EMP_ID, `${NS}_店长`,
      JSON.stringify({ changes: { phone: { from: '13800000002', to: '13800000003' } } })]
  )
  const pclR = await invokeStaffApi('customer.phoneChangeLogs', {
    _testOpenid: TEST_MANAGER_OPENID, clientUserId: TEST_CLIENT_USER_ID,
  })
  if (pclR.code !== 0) {
    errors.push(`phoneChangeLogs code=${pclR.code} msg=${pclR.message}`)
  } else {
    const rows = Array.isArray(pclR.data) ? pclR.data : []
    if (rows.length < 2) {
      errors.push(`phoneChangeLogs 应≥2 条（auth.rebindPhone + customer.update），实际=${rows.length}`)
    } else {
      const adminRow = rows.find(x => x.source === 'admin')
      const clientRow = rows.find(x => x.source === 'client')
      if (!adminRow) errors.push(`phoneChangeLogs 缺 source='admin' 行（customer.update）`)
      if (!clientRow) errors.push(`phoneChangeLogs 缺 source='client' 行（auth.rebindPhone）`)
      if (adminRow && !adminRow.oldPhone) errors.push(`admin 行 oldPhone 应来自 detail.changes.phone.from`)
      if (clientRow && clientRow.operatorLabel !== '顾客自助') {
        errors.push(`client 自助换绑行 operatorLabel 应='顾客自助'，实际='${clientRow.operatorLabel}'`)
      }
      rec(`  ✓ phoneChangeLogs: ${rows.length} 条（含 admin/client 两源）`)
    }
  }

  // 局部 cleanup（cleanupTestData 不清 operation_logs 按 target_id 关联到 NS 客户的）
  // 实际 fixtures.mjs:953 的 cleanupTestData 会按 NS 前缀清 client_wechat_users，但 operation_logs 单独靠 target_id；
  // 此处显式 DELETE，避免污染下一 smoke
  await pgQuery(
    `DELETE FROM operation_logs WHERE target_id = $1 AND action IN ('auth.rebindPhone', 'customer.update')`,
    [TEST_CLIENT_USER_ID]
  )

  if (errors.length) {
    rec(`  ✗ FAIL`); for (const e of errors) rec(`    - ${e}`); return
  }
  pass = true; exitCode = 0
  rec(`  ✅ PASS — detail + appointments + phoneChangeLogs`)
}

try { await main() } catch (e) { console.error('EXCEPTION:', e.message); console.error(e.stack) }
finally {
  try { await cleanupTestData(NS) } catch {}
  await closePool()
  console.log(`[smoke-customer-detail] end | ${pass ? 'PASS' : 'FAIL'} | exit=${exitCode}`)
  process.exit(exitCode)
}
