#!/usr/bin/env node

/**
 * repair-bundle-conversion-2608160038.js
 *
 * 定向修复生产转换单 FY-XSD-WX-2608160038：员工端创建组合套餐转换单时未传
 * bundleProductId，staffApi 将套餐子项按普通 SKU 单价重算为 8740，减旧卡 3000 后
 * 错误收款 5740。套餐 prod-1786846961682 的权威下沉价为：
 *   - 循环系统·二维颈锁：1980 × 3
 *   - 紧肤系统·一维小V脸：0 × 1
 * 因此转入 5940 - 转出 3000 = 应付/实付 2940。
 *
 * 默认 DRY-RUN：执行完整事务与后置断言后 ROLLBACK。
 * APPLY 仅允许显式连接生产库，并要求二次确认订单号：
 *
 *   DATABASE_URL="postgresql://***@118.178.196.26:5433/fengyu_wxapp" \
 *     node db/scripts/repair-bundle-conversion-2608160038.js
 *
 *   DATABASE_URL="postgresql://***@118.178.196.26:5433/fengyu_wxapp" \
 *     node db/scripts/repair-bundle-conversion-2608160038.js \
 *       --apply --confirm-order=FY-XSD-WX-2608160038
 */

const { Client } = require('pg')

const TARGET_ORDER_ID = 'FY-XSD-WX-2608160038'
const CLOSED_SCREENSHOT_ORDER_ID = 'FY-XSD-WX-2608160040'
const TARGET_PAYMENT_ID = 196709
const TARGET_BUNDLE_ID = 'prod-1786846961682'
const SOURCE_SKU_ID = 'sku-1779348199994'
const NECK_SKU_ID = 'sku-1785821470172'
const V_FACE_SKU_ID = 'sku-1785821676138'
const EXPECTED_OLD_AMOUNT = 5740
const EXPECTED_NEW_AMOUNT = 2940
const EXPECTED_IN_AMOUNT = 5940
const EXPECTED_OUT_AMOUNT = -3000

const APPLY = process.argv.includes('--apply')
const CONFIRMED_ORDER = (process.argv.find((arg) => arg.startsWith('--confirm-order=')) || '').split('=')[1]

function log(message) {
  console.log(`[REPAIR-BUNDLE-CONVERSION-0038] ${new Date().toISOString()} ${message}`)
}

function fail(message) {
  throw new Error(`前置/后置断言失败：${message}`)
}

function assert(condition, message) {
  if (!condition) fail(message)
}

function money(value) {
  return Math.round(Number(value || 0) * 100) / 100
}

function maskedUrl(raw) {
  return raw.replace(/:[^:@/]+@/, ':***@')
}

async function loadSnapshot(client) {
  const orderResult = await client.query(
    `SELECT sale_order_id, status, sale_order_type, client_user_id, payment_method,
            total_amount, payable_amount, prepaid_card_amount, received, refunded_amount,
            first_payment_amount, allocation_status, paid_at
       FROM sale_orders
      WHERE sale_order_id = $1
      FOR UPDATE`,
    [TARGET_ORDER_ID],
  )

  const paymentResult = await client.query(
    `SELECT id, change_type, amount, payment_method, status, allocation_status, paid_at
       FROM sale_order_payments
      WHERE sale_order_id = $1
      ORDER BY id
      FOR UPDATE`,
    [TARGET_ORDER_ID],
  )

  const itemResult = await client.query(
    `SELECT sale_item_id, item_direction, ref_sale_item_id, sku_id, product_name,
            quantity, session_count, remaining_sessions, paid_sessions,
            unit_price, unit_real_price, sale_amount, received
       FROM sale_items
      WHERE sale_order_id = $1
      ORDER BY item_direction, sale_item_id
      FOR UPDATE`,
    [TARGET_ORDER_ID],
  )

  const receiptResult = await client.query(
    `SELECT spir.id, spir.sale_payment_id, spir.sale_item_id, spir.amount
       FROM sale_payment_item_receipts spir
      WHERE spir.sale_order_id = $1
      ORDER BY spir.id
      FOR UPDATE`,
    [TARGET_ORDER_ID],
  )

  return {
    order: orderResult.rows[0] || null,
    payments: paymentResult.rows,
    items: itemResult.rows,
    receipts: receiptResult.rows,
  }
}

function aggregate(snapshot) {
  const inItems = snapshot.items.filter((item) => item.item_direction === '转入')
  const outItems = snapshot.items.filter((item) => item.item_direction === '转出')
  return {
    inSale: money(inItems.reduce((sum, item) => sum + Number(item.sale_amount), 0)),
    outSale: money(outItems.reduce((sum, item) => sum + Number(item.sale_amount), 0)),
    netSale: money(snapshot.items.reduce((sum, item) => sum + Number(item.sale_amount), 0)),
    netItemReceived: money(snapshot.items.reduce((sum, item) => sum + Number(item.received), 0)),
    paymentTotal: money(snapshot.payments
      .filter((payment) => payment.status === '已支付'
        && ['首次支付', '回款', '储值卡抵扣'].includes(payment.change_type))
      .reduce((sum, payment) => sum + Number(payment.amount), 0)),
    receiptTotal: money(snapshot.receipts.reduce((sum, receipt) => sum + Number(receipt.amount), 0)),
  }
}

async function assertBundleConfiguration(client) {
  const result = await client.query(
    `SELECT p.product_id, p.is_bundle, mps.sku_id,
            mps.bundle_group_id, mps.bundle_price, mps.bundle_list_price
       FROM products p
       JOIN mall_product_skus mps ON mps.product_id = p.product_id
      WHERE p.product_id = $1
        AND p.deleted_at IS NULL
        AND mps.sku_id = ANY($2)
      ORDER BY mps.sku_id`,
    [TARGET_BUNDLE_ID, [NECK_SKU_ID, V_FACE_SKU_ID]],
  )
  assert(result.rows.length === 2 && result.rows.every((row) => row.is_bundle === true), '目标套餐或套餐子项不存在')
  const bySku = new Map(result.rows.map((row) => [row.sku_id, row]))
  const neck = bySku.get(NECK_SKU_ID)
  const vFace = bySku.get(V_FACE_SKU_ID)
  assert(money(neck.bundle_price) === 1980 && money(neck.bundle_list_price) === 1980, '二维颈锁套餐价不再是 1980')
  assert(money(vFace.bundle_price) === 0 && money(vFace.bundle_list_price) === 0, '小V脸套餐价不再是 0')
}

async function assertNoDependentSideEffects(client) {
  const result = await client.query(
    `SELECT
       (SELECT COUNT(*)::int
          FROM sale_payment_item_allocations spia
          JOIN sale_payment_item_receipts spir ON spir.id = spia.sale_payment_item_receipt_id
         WHERE spir.sale_order_id = $1 AND spia.is_void = false) AS item_allocations,
       (SELECT COUNT(*)::int FROM sale_allocations WHERE sale_payment_id = $2 AND is_void = false) AS legacy_allocations,
       (SELECT COUNT(*)::int
          FROM service_items
         WHERE sale_item_id IN (
           SELECT sale_item_id FROM sale_items WHERE sale_order_id = $1 AND item_direction = '转入'
         )) AS service_items,
       (SELECT COUNT(*)::int FROM point_transactions WHERE ref_order_id = $1) AS point_transactions`,
    [TARGET_ORDER_ID, TARGET_PAYMENT_ID],
  )
  const row = result.rows[0]
  assert(row.item_allocations === 0, '该款项已经存在逐项营业额分配')
  assert(row.legacy_allocations === 0, '该款项已经存在旧模型营业额分配')
  assert(row.service_items === 0, '转换后的新权益已经生成服务明细')
  assert(row.point_transactions === 0, '该订单已经产生积分流水')
}

async function assertClosedScreenshotOrderUnchanged(client) {
  const result = await client.query(
    `SELECT status, total_amount, payable_amount, received,
            (SELECT COUNT(*) FROM sale_order_payments WHERE sale_order_id = $1) AS payment_count
       FROM sale_orders
      WHERE sale_order_id = $1`,
    [CLOSED_SCREENSHOT_ORDER_ID],
  )
  const order = result.rows[0]
  assert(order, `截图订单 ${CLOSED_SCREENSHOT_ORDER_ID} 不存在`)
  assert(order.status === '已关闭', `截图订单 ${CLOSED_SCREENSHOT_ORDER_ID} 不再是已关闭`)
  assert(money(order.total_amount) === 5740 && money(order.payable_amount) === 5740, '截图订单金额发生了意外变化')
  assert(money(order.received) === 0 && Number(order.payment_count) === 0, '截图订单出现了意外收款')
}

function assertInitialState(snapshot) {
  assert(snapshot.order, `订单 ${TARGET_ORDER_ID} 不存在`)
  const order = snapshot.order
  assert(order.status === '已支付' && order.sale_order_type === '转换单', '目标订单不是已支付转换单')
  assert(order.payment_method === '线下', '目标订单不是线下支付')
  assert(money(order.total_amount) === EXPECTED_OLD_AMOUNT, '目标订单 total_amount 已偏离 5740')
  assert(money(order.payable_amount) === EXPECTED_OLD_AMOUNT, '目标订单 payable_amount 已偏离 5740')
  assert(money(order.received) === EXPECTED_OLD_AMOUNT, '目标订单 received 已偏离 5740')
  assert(money(order.prepaid_card_amount) === 0 && money(order.refunded_amount) === 0, '目标订单已有储值卡抵扣或退款')
  assert(order.first_payment_amount == null, '目标订单 first_payment_amount 非空')
  assert(order.allocation_status === '待分配', '目标订单不再是待分配状态')

  assert(snapshot.payments.length === 1, '目标订单不再是单笔款项')
  const payment = snapshot.payments[0]
  assert(Number(payment.id) === TARGET_PAYMENT_ID, `目标款项 ID 不再是 ${TARGET_PAYMENT_ID}`)
  assert(payment.change_type === '首次支付' && payment.status === '已支付', '目标款项不是已支付首次支付')
  assert(payment.payment_method === '线下' && payment.allocation_status === '待分配', '目标款项通道或分配状态发生变化')
  assert(money(payment.amount) === EXPECTED_OLD_AMOUNT, '目标款项金额已偏离 5740')

  const outItems = snapshot.items.filter((item) => item.item_direction === '转出')
  const neckItems = snapshot.items.filter((item) => item.item_direction === '转入' && item.sku_id === NECK_SKU_ID)
  const vFaceItems = snapshot.items.filter((item) => item.item_direction === '转入' && item.sku_id === V_FACE_SKU_ID)
  assert(snapshot.items.length === 10, '目标订单明细不再是 10 行')
  assert(outItems.length === 6 && outItems.every((item) => item.sku_id === SOURCE_SKU_ID), '转出旧卡不再是目标 6 张卡')
  assert(neckItems.length === 3 && vFaceItems.length === 1, '转入套餐子项数量发生变化')

  const totals = aggregate(snapshot)
  assert(totals.inSale === 8740 && totals.outSale === EXPECTED_OUT_AMOUNT && totals.netSale === EXPECTED_OLD_AMOUNT,
    '修复前商品金额不再是 8740 - 3000 = 5740')
  assert(totals.paymentTotal === EXPECTED_OLD_AMOUNT && totals.receiptTotal === EXPECTED_OLD_AMOUNT,
    '修复前款项或 receipt 合计不再是 5740')
  assert(snapshot.receipts.length === 10, '修复前 receipt 不再完整覆盖 10 个子项')
}

function isAlreadyCorrect(snapshot) {
  if (!snapshot.order || snapshot.payments.length !== 1) return false
  const totals = aggregate(snapshot)
  return snapshot.order.status === '已支付'
    && money(snapshot.order.total_amount) === EXPECTED_NEW_AMOUNT
    && money(snapshot.order.payable_amount) === EXPECTED_NEW_AMOUNT
    && money(snapshot.order.received) === EXPECTED_NEW_AMOUNT
    && money(snapshot.payments[0].amount) === EXPECTED_NEW_AMOUNT
    && totals.inSale === EXPECTED_IN_AMOUNT
    && totals.outSale === EXPECTED_OUT_AMOUNT
    && totals.netSale === EXPECTED_NEW_AMOUNT
    && totals.netItemReceived === EXPECTED_NEW_AMOUNT
    && totals.paymentTotal === EXPECTED_NEW_AMOUNT
    && totals.receiptTotal === EXPECTED_NEW_AMOUNT
}

async function applyRepair(client) {
  const itemUpdate = await client.query(
    `UPDATE sale_items si
        SET unit_price = CASE si.sku_id WHEN $2 THEN 1980.00 ELSE 0.00 END,
            unit_real_price = CASE si.sku_id WHEN $2 THEN 1980.00 ELSE 0.00 END,
            sale_amount = CASE si.sku_id WHEN $2 THEN 1980.00 ELSE 0.00 END,
            received = CASE si.sku_id WHEN $2 THEN 1980.00 ELSE 0.00 END,
            paid_sessions = CASE WHEN si.session_count IS NULL THEN NULL ELSE si.session_count END,
            updated_at = NOW()
      WHERE si.sale_order_id = $1
        AND si.item_direction = '转入'
        AND si.sku_id IN ($2, $3)`,
    [TARGET_ORDER_ID, NECK_SKU_ID, V_FACE_SKU_ID],
  )
  assert(itemUpdate.rowCount === 4, '未精确更新 4 条转入套餐明细')

  const outUpdate = await client.query(
    `UPDATE sale_items
        SET received = sale_amount,
            paid_sessions = CASE WHEN session_count IS NULL THEN NULL ELSE session_count END,
            updated_at = NOW()
      WHERE sale_order_id = $1 AND item_direction = '转出'`,
    [TARGET_ORDER_ID],
  )
  assert(outUpdate.rowCount === 6, '未精确刷新 6 条转出明细')

  const paymentUpdate = await client.query(
    `UPDATE sale_order_payments
        SET amount = $1
      WHERE id = $2 AND sale_order_id = $3`,
    [EXPECTED_NEW_AMOUNT.toFixed(2), TARGET_PAYMENT_ID, TARGET_ORDER_ID],
  )
  assert(paymentUpdate.rowCount === 1, '未精确更新目标付款流水')

  const orderUpdate = await client.query(
    `UPDATE sale_orders
        SET total_amount = $1,
            payable_amount = $1,
            received = $1,
            updated_at = NOW()
      WHERE sale_order_id = $2`,
    [EXPECTED_NEW_AMOUNT.toFixed(2), TARGET_ORDER_ID],
  )
  assert(orderUpdate.rowCount === 1, '未精确更新目标订单')

  await client.query(
    `UPDATE sale_payment_item_receipts spir
        SET amount = si.sale_amount
       FROM sale_items si
      WHERE spir.sale_order_id = $1
        AND spir.sale_payment_id = $2
        AND si.sale_item_id = spir.sale_item_id
        AND si.sale_amount <> 0`,
    [TARGET_ORDER_ID, TARGET_PAYMENT_ID],
  )
  const zeroReceiptDelete = await client.query(
    `DELETE FROM sale_payment_item_receipts spir
      USING sale_items si
      WHERE spir.sale_order_id = $1
        AND spir.sale_payment_id = $2
        AND si.sale_item_id = spir.sale_item_id
        AND si.sale_amount = 0`,
    [TARGET_ORDER_ID, TARGET_PAYMENT_ID],
  )
  assert(zeroReceiptDelete.rowCount === 1, '未精确删除 1 条零元套餐 receipt')

  const auditInsert = await client.query(
    `INSERT INTO operation_logs
       (operator_employee_id, operator_name, operator_role, org_node_id, org_node_name,
        action, target_type, target_id, detail, source, created_at)
     SELECT NULL, NULL, NULL, NULL, NULL,
            'order.repairBundleConversionPricing', 'sale_order', $1, $2::jsonb, 'maintenance', NOW()
      WHERE NOT EXISTS (
        SELECT 1 FROM operation_logs
         WHERE action = 'order.repairBundleConversionPricing' AND target_id = $1
      )`,
    [TARGET_ORDER_ID, JSON.stringify({
      _v: 1,
      reason: 'bundleProductId missing caused bundle children to be repriced as ordinary SKUs',
      bundleProductId: TARGET_BUNDLE_ID,
      before: { totalAmount: EXPECTED_OLD_AMOUNT, received: EXPECTED_OLD_AMOUNT },
      after: { totalAmount: EXPECTED_NEW_AMOUNT, received: EXPECTED_NEW_AMOUNT },
      paymentId: TARGET_PAYMENT_ID,
    })],
  )
  assert(auditInsert.rowCount === 1, '未写入唯一的数据修复审计日志')
}

function assertFinalState(snapshot) {
  assert(isAlreadyCorrect(snapshot), '修复后订单/款项/明细/receipt 金额未全部收敛到 2940')
  const order = snapshot.order
  assert(order.status === '已支付' && order.payment_method === '线下', '修复后订单状态或支付通道发生变化')
  assert(order.allocation_status === '待分配' && snapshot.payments[0].allocation_status === '待分配', '修复后分配状态发生变化')
  assert(snapshot.receipts.length === 9, '修复后应保留 9 条非零 receipt')
  const neckItems = snapshot.items.filter((item) => item.item_direction === '转入' && item.sku_id === NECK_SKU_ID)
  const vFaceItem = snapshot.items.find((item) => item.item_direction === '转入' && item.sku_id === V_FACE_SKU_ID)
  assert(neckItems.every((item) => money(item.unit_price) === 1980
    && money(item.unit_real_price) === 1980
    && money(item.sale_amount) === 1980
    && money(item.received) === 1980), '二维颈锁 3 行未全部按套餐价 1980 修复')
  assert(vFaceItem && money(vFaceItem.unit_price) === 0
    && money(vFaceItem.unit_real_price) === 0
    && money(vFaceItem.sale_amount) === 0
    && money(vFaceItem.received) === 0
    && Number(vFaceItem.paid_sessions) === Number(vFaceItem.session_count), '零元小V脸权益未保持全额可用')
}

async function main() {
  const databaseUrl = process.env.DATABASE_URL
  if (!databaseUrl) {
    console.error('FATAL: 必须显式设置 DATABASE_URL')
    process.exit(1)
  }

  const parsed = new URL(databaseUrl)
  if (APPLY) {
    if (CONFIRMED_ORDER !== TARGET_ORDER_ID) {
      console.error(`FATAL: APPLY 必须追加 --confirm-order=${TARGET_ORDER_ID}`)
      process.exit(1)
    }
    if (parsed.hostname !== '118.178.196.26' || parsed.port !== '5433' || parsed.pathname !== '/fengyu_wxapp') {
      console.error('FATAL: APPLY 仅允许生产库 118.178.196.26:5433/fengyu_wxapp')
      process.exit(1)
    }
  }

  log(`目标库: ${maskedUrl(databaseUrl)}`)
  log(`模式: ${APPLY ? 'APPLY（提交）' : 'DRY-RUN（完整执行后回滚）'}`)

  const client = new Client({ connectionString: databaseUrl })
  await client.connect()
  try {
    await client.query('BEGIN')
    await assertBundleConfiguration(client)
    await assertClosedScreenshotOrderUnchanged(client)
    await assertNoDependentSideEffects(client)

    const before = await loadSnapshot(client)
    if (isAlreadyCorrect(before)) {
      log(`订单 ${TARGET_ORDER_ID} 已是正确状态：应付/实付 2940，无需重复修复`)
      await client.query('ROLLBACK')
      return
    }
    assertInitialState(before)
    const beforeTotals = aggregate(before)
    log(`修复前：转入 ${beforeTotals.inSale.toFixed(2)}，转出 ${beforeTotals.outSale.toFixed(2)}，订单/实付 ${beforeTotals.netSale.toFixed(2)}`)

    await applyRepair(client)

    const after = await loadSnapshot(client)
    assertFinalState(after)
    await assertClosedScreenshotOrderUnchanged(client)
    await assertNoDependentSideEffects(client)
    const afterTotals = aggregate(after)
    log(`修复后：转入 ${afterTotals.inSale.toFixed(2)}，转出 ${afterTotals.outSale.toFixed(2)}，订单/实付 ${afterTotals.netSale.toFixed(2)}`)

    if (APPLY) {
      await client.query('COMMIT')
      log(`已提交生产订单 ${TARGET_ORDER_ID} 的金额订正 ✓`)
    } else {
      await client.query('ROLLBACK')
      log('DRY-RUN 已回滚；所有前置、更新和后置断言均通过')
    }
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {})
    console.error('[REPAIR-BUNDLE-CONVERSION-0038] 修复失败，已回滚：', error)
    process.exitCode = 1
  } finally {
    await client.end()
  }
}

main().catch((error) => {
  console.error('FATAL:', error)
  process.exit(1)
})
