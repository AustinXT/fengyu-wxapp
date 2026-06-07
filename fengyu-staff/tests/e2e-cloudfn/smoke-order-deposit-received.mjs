#!/usr/bin/env bun
/**
 * order.updateDepositReceived 寄存单历史实收录入冒烟
 *
 * 背景：commit 5972dcb1 feat(order): 寄存单历史实收录入(staff)。
 * 寄存单（sale_order_type='寄存单'，total_amount 恒为 0）承载老顾客剩余次数初始化，
 * 但可补录各行「历史实收金额」用于审计。updateDepositReceived 全量重设：
 *   - 删除该单所有「寄存单初始化实收」标记的 '回款'(线下) 流水，按新 items 重建
 *   - sale_orders.received = Σ received，total_amount 仍保持 0
 *   - recalc STEP1 把 targeted 流水落回各行 sale_items.received
 * 契约：仅店长(requireManager) + 门店 scope + 仅寄存单(INVALID_STATE) + 各项校验(INVALID_PARAMS)。
 *
 * 验证点：
 *   1. 建寄存单（createDeposit）时 received=0 → 0 条历史实收流水、sale_orders.received=0
 *      + unit_real_price 回落标价单价 unit_price（=1000/10=100），非置 0
 *   2. updateDepositReceived 录入 600 → sale_orders.received=600
 *      + 恰 1 条 change_type='回款'/note='寄存单初始化实收'/source_end='staff'/amount=600 流水（ref=该行）
 *      + sale_items.received 被 recalc 落回 600（total_amount 仍=0）
 *      + unit_real_price 按实付重算 = 600/10 = 60
 *   3. 全量重设：再次调改成 300 → 旧流水删重建为恰 1 条 amount=300、sale_orders.received=300
 *      （不会累积成 2 条；这是"删重建"语义守护）+ unit_real_price = 300/10 = 30
 *   4. 录入 0（清空）→ 0 条历史实收流水、received=0
 *      + unit_real_price 回落标价单价 100（reset 必须恢复 unit_price 的守护点）
 *   5. 边界 a：received 为负 → INVALID_PARAMS（不落库，received 不变）
 *   6. 边界 b：对非寄存单（销售单）调用 → INVALID_STATE
 *   7. 边界 c：非店长（普通员工）调用 → PERMISSION_DENIED
 *   8. 边界 d：items 行不属于本单 → INVALID_PARAMS
 */
import './setup.mjs'
import {
  NS,
  TEST_MANAGER_OPENID,
  TEST_CLIENT_USER_ID,
  TEST_STORE_ID, TEST_STORE_ORG_ID,
  pgQuery, closePool,
} from './setup.mjs'
import { invokeStaffApi } from './helpers/invoke.mjs'
import {
  ensureTestStore, createTestStaff, createTestClient,
  createTestProduct, createTestSaleOrder,
  cleanupTestData, invalidateStaffAuthCache,
} from './helpers/fixtures.mjs'

// 普通员工（非店长）夹具：复用本测试专用前缀，号段 19999098016
const WORKER_EMP_ID = `${NS}_DEPRCV_WORKER`
const WORKER_OPENID = `${NS}_DEPRCV_WORKER_OPENID`
const WORKER_PHONE = '19999098016'

let pass = false
let exitCode = 1
function rec(line) { console.log(line) }

// 查该单的「寄存单初始化实收」流水
async function depositReceipts(saleOrderId) {
  return await pgQuery(
    `SELECT amount, change_type, payment_method, source_end, note, ref_sale_item_id, status
       FROM sale_order_payments
      WHERE sale_order_id = $1 AND change_type = '回款' AND note = '寄存单初始化实收'
      ORDER BY created_at`,
    [saleOrderId]
  )
}
async function orderReceived(saleOrderId) {
  const rows = await pgQuery(
    `SELECT received, total_amount FROM sale_orders WHERE sale_order_id = $1`,
    [saleOrderId]
  )
  return rows[0]
}
// 查某明细行的实收 + 实际单价（unit_real_price）+ 标价单价（unit_price）
async function itemPrices(saleItemId) {
  const rows = await pgQuery(
    `SELECT received::numeric AS recv, unit_real_price::numeric AS urp, unit_price::numeric AS up
       FROM sale_items WHERE sale_item_id = $1`,
    [saleItemId]
  )
  return rows[0]
}

async function main() {
  rec(`[smoke-order-deposit-received] start | ${new Date().toISOString()}`)

  await cleanupTestData(NS)
  await ensureTestStore()
  await createTestStaff()       // manager
  await createTestClient()
  // 普通员工（isManager=false → 不建 manager 角色绑定），用于越权断言
  await createTestStaff({
    employeeId: WORKER_EMP_ID,
    openid: WORKER_OPENID,
    phone: WORKER_PHONE,
    name: `${NS}_DEPRCV_普通员工`,
    isManager: false,
    positionName: '美容师',
  })
  // 同进程改了 permission_roles，必须清 staffApi AUTH_CACHE
  await invalidateStaffAuthCache([TEST_MANAGER_OPENID, WORKER_OPENID])

  // 疗程卡 SKU：10 次 × ¥1000（整卡），per-session=100
  const sku = await createTestProduct({
    suffix: 'DEPRCV',
    productKind: '护理项目',
    productType: '疗程卡',
    salesCategory: '他销他耗',
    price: 1000,
    sessionCount: 10,
  })
  rec(`  ✓ fixture: 疗程卡 ${sku.skuId} (10次×¥1000)`)

  // ─── 建寄存单（received=0 不录入历史实收）───
  const created = await invokeStaffApi('order.createDeposit', {
    _testOpenid: TEST_MANAGER_OPENID,
    clientUserId: TEST_CLIENT_USER_ID,
    items: [{ skuId: sku.skuId, quantity: 1 }],
    remark: 'e2e-deposit-received',
  })
  if (created.code !== 0) {
    rec(`  ✗ FAIL: createDeposit code=${created.code} msg=${created.message}`)
    return
  }
  const saleOrderId = created.data?.saleOrderId
  rec(`  result: deposit order=${saleOrderId}`)

  // 取该单唯一明细行 sale_item_id
  const itemRows = await pgQuery(
    `SELECT sale_item_id FROM sale_items WHERE sale_order_id = $1 AND item_direction = '购买'`,
    [saleOrderId]
  )
  if (itemRows.length !== 1) {
    rec(`  ✗ FAIL: 预期 1 个购买明细行，实际=${itemRows.length}`)
    return
  }
  const saleItemId = itemRows[0].sale_item_id

  const errors = []

  // ─── 1. 初始态：received=0 / 无历史实收流水 ───
  {
    const o = await orderReceived(saleOrderId)
    if (Number(o.received) !== 0) errors.push(`初始 sale_orders.received 应=0，实际=${o.received}`)
    if (Number(o.total_amount) !== 0) errors.push(`初始 total_amount 应=0，实际=${o.total_amount}`)
    const r = await depositReceipts(saleOrderId)
    if (r.length !== 0) errors.push(`初始历史实收流水应=0 条，实际=${r.length}`)
    // 实付=0 → unit_real_price 回落标价单价 unit_price（=1000/10=100），不置 0
    const pr = await itemPrices(saleItemId)
    if (Number(pr.up) !== 100) errors.push(`初始 unit_price 应=100（标价1000/10），实际=${pr.up}`)
    if (Number(pr.urp) !== 100) errors.push(`初始(实付0) unit_real_price 应回落=100（标价单价），实际=${pr.urp}`)
  }

  // ─── 2. 录入 600 ───
  {
    const res = await invokeStaffApi('order.updateDepositReceived', {
      _testOpenid: TEST_MANAGER_OPENID,
      saleOrderId,
      items: [{ saleItemId, received: 600 }],
    })
    if (res.code !== 0) {
      errors.push(`录入600 应成功，实际 code=${res.code} msg=${res.message}`)
    } else {
      const o = await orderReceived(saleOrderId)
      if (Number(o.received) !== 600) errors.push(`录入600后 sale_orders.received 应=600，实际=${o.received}`)
      if (Number(o.total_amount) !== 0) errors.push(`录入600后 total_amount 仍应=0，实际=${o.total_amount}`)
      const r = await depositReceipts(saleOrderId)
      if (r.length !== 1) {
        errors.push(`录入600后历史实收流水应=1 条，实际=${r.length}`)
      } else {
        const p = r[0]
        if (Number(p.amount) !== 600) errors.push(`流水 amount 应=600，实际=${p.amount}`)
        if (p.payment_method !== '线下') errors.push(`流水 payment_method 应='线下'，实际='${p.payment_method}'`)
        if (p.source_end !== 'staff') errors.push(`流水 source_end 应='staff'，实际='${p.source_end}'`)
        if (p.status !== '已支付') errors.push(`流水 status 应='已支付'，实际='${p.status}'`)
        if (p.ref_sale_item_id !== saleItemId) errors.push(`流水 ref_sale_item_id 应=${saleItemId}，实际=${p.ref_sale_item_id}`)
      }
      // recalc STEP1 把 targeted 流水落回各行 received；unit_real_price 按实付重算 = 600/10 = 60
      const pr = await itemPrices(saleItemId)
      if (Number(pr.recv) !== 600) errors.push(`录入600后 sale_items.received 应=600（recalc落回），实际=${pr.recv}`)
      if (Number(pr.urp) !== 60) errors.push(`录入600后 unit_real_price 应=60（实付600/10），实际=${pr.urp}`)
      if (Number(pr.up) !== 100) errors.push(`录入600后 unit_price 应仍=100（标价不变），实际=${pr.up}`)
    }
  }

  // ─── 3. 全量重设：改成 300（删重建，不应累积）───
  {
    const res = await invokeStaffApi('order.updateDepositReceived', {
      _testOpenid: TEST_MANAGER_OPENID,
      saleOrderId,
      items: [{ saleItemId, received: 300 }],
    })
    if (res.code !== 0) {
      errors.push(`改300 应成功，实际 code=${res.code} msg=${res.message}`)
    } else {
      const o = await orderReceived(saleOrderId)
      if (Number(o.received) !== 300) errors.push(`改300后 sale_orders.received 应=300，实际=${o.received}`)
      const r = await depositReceipts(saleOrderId)
      if (r.length !== 1) errors.push(`改300后历史实收流水应=1 条（删重建非累积），实际=${r.length}`)
      else if (Number(r[0].amount) !== 300) errors.push(`改300后流水 amount 应=300，实际=${r[0].amount}`)
      // unit_real_price 跟随重算 = 300/10 = 30
      const pr = await itemPrices(saleItemId)
      if (Number(pr.urp) !== 30) errors.push(`改300后 unit_real_price 应=30（实付300/10），实际=${pr.urp}`)
    }
  }

  // ─── 4. 清空：录入 0 → 0 条流水、received=0 ───
  {
    const res = await invokeStaffApi('order.updateDepositReceived', {
      _testOpenid: TEST_MANAGER_OPENID,
      saleOrderId,
      items: [{ saleItemId, received: 0 }],
    })
    if (res.code !== 0) {
      errors.push(`清空(录0) 应成功，实际 code=${res.code} msg=${res.message}`)
    } else {
      const o = await orderReceived(saleOrderId)
      if (Number(o.received) !== 0) errors.push(`清空后 sale_orders.received 应=0，实际=${o.received}`)
      const r = await depositReceipts(saleOrderId)
      if (r.length !== 0) errors.push(`清空后历史实收流水应=0 条，实际=${r.length}`)
      // reset 守护：实付清空后 unit_real_price 必须回落标价单价 100，不能残留旧实付价 30
      const pr = await itemPrices(saleItemId)
      if (Number(pr.urp) !== 100) errors.push(`清空后 unit_real_price 应回落=100（标价单价，不残留旧30），实际=${pr.urp}`)
    }
  }

  // ─── 5. 边界 a：received 为负 → INVALID_PARAMS（不落库）───
  {
    const res = await invokeStaffApi('order.updateDepositReceived', {
      _testOpenid: TEST_MANAGER_OPENID,
      saleOrderId,
      items: [{ saleItemId, received: -100 }],
    })
    if (res.code !== -400 || res.errorType !== 'INVALID_PARAMS') {
      errors.push(`负金额应=INVALID_PARAMS(-400)，实际 code=${res.code} errorType=${res.errorType}`)
    }
    // 事务回滚：received 仍=0
    const o = await orderReceived(saleOrderId)
    if (Number(o.received) !== 0) errors.push(`负金额拒绝后 received 应不变=0，实际=${o.received}`)
  }

  // ─── 6. 边界 b：对非寄存单（销售单）调用 → INVALID_STATE ───
  {
    const salesOrderId = `${NS}_DEPRCV_SALES`
    await createTestSaleOrder({
      saleOrderId: salesOrderId,
      clientUserId: TEST_CLIENT_USER_ID,
      status: '已支付',
      saleOrderType: '销售单',
      productType: '疗程卡',
      sessionCount: 10,
      salesCategory: '他销他耗',
      totalAmount: 1000,
    })
    const salesItemRows = await pgQuery(
      `SELECT sale_item_id FROM sale_items WHERE sale_order_id = $1 LIMIT 1`, [salesOrderId]
    )
    const res = await invokeStaffApi('order.updateDepositReceived', {
      _testOpenid: TEST_MANAGER_OPENID,
      saleOrderId: salesOrderId,
      items: [{ saleItemId: salesItemRows[0]?.sale_item_id || 'x', received: 100 }],
    })
    if (res.code !== -400 || res.errorType !== 'INVALID_STATE') {
      errors.push(`非寄存单应=INVALID_STATE(-400)，实际 code=${res.code} errorType=${res.errorType} msg=${res.message}`)
    }
  }

  // ─── 7. 边界 c：非店长调用 → PERMISSION_DENIED ───
  {
    const res = await invokeStaffApi('order.updateDepositReceived', {
      _testOpenid: WORKER_OPENID,
      saleOrderId,
      items: [{ saleItemId, received: 100 }],
    })
    if (res.code !== -403 || res.errorType !== 'PERMISSION_DENIED') {
      errors.push(`非店长应=PERMISSION_DENIED(-403)，实际 code=${res.code} errorType=${res.errorType} msg=${res.message}`)
    }
  }

  // ─── 8. 边界 d：items 行不属于本单 → INVALID_PARAMS ───
  {
    const res = await invokeStaffApi('order.updateDepositReceived', {
      _testOpenid: TEST_MANAGER_OPENID,
      saleOrderId,
      items: [{ saleItemId: `${NS}_DEPRCV_NOSUCH_ITEM`, received: 100 }],
    })
    if (res.code !== -400 || res.errorType !== 'INVALID_PARAMS') {
      errors.push(`外来明细行应=INVALID_PARAMS(-400)，实际 code=${res.code} errorType=${res.errorType} msg=${res.message}`)
    }
  }

  if (errors.length) {
    rec(`  ✗ FAIL: ${errors.length} 项断言失败`)
    for (const e of errors) rec(`    - ${e}`)
    return
  }

  pass = true
  exitCode = 0
  rec('  ✅ PASS — updateDepositReceived 录入/重设/清空 + 流水删重建 + received落回 + unit_real_price 按实付重算(60/30/回落100) + 4 项边界(负值/非寄存单/越权/外来行)')
}

try {
  await main()
} catch (e) {
  console.error('[smoke-order-deposit-received] EXCEPTION:', e.message)
  if (e?.stack) console.error(e.stack)
} finally {
  try { await cleanupTestData(NS) } catch (e) { console.error('[cleanup error]', e.message) }
  await closePool()
  console.log(`[smoke-order-deposit-received] end | ${pass ? 'PASS' : 'FAIL'} | exit=${exitCode}`)
  process.exit(exitCode)
}
