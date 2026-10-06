#!/usr/bin/env bun
/**
 * 寄存单退款冒烟（issue #543，2026-10-06）— createRefund → approveRefund 全链路
 *
 * 口径：只放开「退款」；「回款 / 改实收」仍锁；历史订单三项全锁。
 * 只退未消耗部分：已核销次数不回滚，退款额按历史实收折算并封顶。
 *
 * 覆盖：
 *   D1 多行寄存单 · 有历史实收 · 部分消耗 → 退款全流程
 *      · 白名单已放行（原「仅销售单支持退款」已改「仅销售单/寄存单支持退款」）
 *      · 通道 1 对寄存单豁免（该单无任何 sale_payment_item_receipts；多行时
 *        buildReceiptRefundItems 的残值映射必抛「退款金额无法完整映射到商品行实收」）
 *      · paid_sessions 按未消耗次数下降（零金额兜底分支扣 rights.refunded_sessions）
 *      · 不触发 D3：paid_sessions 恰等于已消费次数，判据是严格 >
 *      · 全部行可用权益退光 ⇒ sale_orders.status 置「已退款」终态（绝不能被误判成「部分支付」）
 *      · 二次退款被可退数量门拦住（防重复退款）
 *   D2 0 元寄存单（received=0 → unit_real_price=0）· 部分消耗 → 只退次数、金额 0
 *      · isZeroCashPaidSessionRefund 对寄存单放宽（部分消耗时 isFullItemRefund 恒 false）
 *   D3 回款仍锁：寄存单 createRepayment → INVALID_STATE/寄存单
 *   D4 豁免范围不扩散：多行**销售单**无 receipt 仍抛残值映射错误
 *   D5 驳回无副作用（验收 6）：流水翻「已作废」、金额/次数/实收零变化、可重新发起
 *   D6 家居寄存件退款（验收 3）：级联通道 5 累加 refunded_quantity → 可提量收敛到 0
 *   D7 只退其中一行 → 不跳「已退款」终态、也不落「部分支付」（#543 追加口径的边界）
 */
import './setup.mjs'
import {
  NS,
  TEST_MANAGER_OPENID,
  TEST_CLIENT_USER_ID,
  pgQuery, closePool,
} from './setup.mjs'
import { invokeStaffApi } from './helpers/invoke.mjs'
import {
  ensureTestStore, createTestStaff, createTestClient,
  createTestSaleOrder, createTestSaleItem, cleanupTestData, invalidateStaffAuthCache,
} from './helpers/fixtures.mjs'

let pass = false
let exitCode = 1
const rec = (l) => console.log(l)
const n2 = (v) => Number(v ?? 0)

/**
 * 造一张「已入账」状态的多行寄存单。
 * ⚠ 刻意**不写 sale_payment_item_receipts** —— 真实寄存单该表恒零行（prod 实测 0 行），
 *   这正是通道 1 需要豁免的原因；补 receipt 会让用例失去意义。
 */
async function seedDepositOrder(orderId, rows, { received = 0 } = {}) {
  await createTestSaleOrder({
    saleOrderId: orderId, clientUserId: TEST_CLIENT_USER_ID,
    saleOrderType: '寄存单', productName: `${NS}_寄存卡`, productType: '疗程卡',
    quantity: 1, sessionCount: rows[0].sessionCount, totalAmount: 0,
    status: '已支付', salesCategory: '他销自耗',
  })
  // 第一行已被 createTestSaleOrder 建好，补齐金额/次数口径
  const first = rows[0]
  await pgQuery(
    `UPDATE sale_items SET session_count=$2, remaining_sessions=$3, paid_sessions=$4,
            sale_amount=$5, received=$6, unit_price=$7, unit_real_price=$8
      WHERE sale_item_id=$1`,
    [`${orderId}_ITEM_1`, first.sessionCount, first.remaining, first.sessionCount,
      first.saleAmount, first.received, first.saleAmount / first.sessionCount, first.unitRealPrice],
  )
  for (let i = 1; i < rows.length; i += 1) {
    const r = rows[i]
    const itemId = `${orderId}_ITEM_${i + 1}`
    await createTestSaleItem({
      saleOrderId: orderId, saleItemId: itemId,
      productName: `${NS}_寄存卡${i + 1}`, productType: '疗程卡',
      quantity: 1, unitPrice: r.saleAmount, sessionCount: r.sessionCount,
      salesCategory: '他销自耗',
    })
    await pgQuery(
      `UPDATE sale_items SET remaining_sessions=$2, paid_sessions=$3,
              sale_amount=$4, received=$5, unit_real_price=$6
        WHERE sale_item_id=$1`,
      [itemId, r.remaining, r.sessionCount, r.saleAmount, r.received, r.unitRealPrice],
    )
  }
  await pgQuery(
    `UPDATE sale_orders SET received=$2, total_amount=0, payment_method='无' WHERE sale_order_id=$1`,
    [orderId, received],
  )
  // 历史实收回款行（定向到行），与 createDepositOrder + approveDepositOrder 落库形态一致。
  // 仍**不写** receipt。
  for (let i = 0; i < rows.length; i += 1) {
    if (n2(rows[i].received) <= 0) continue
    await pgQuery(
      `INSERT INTO sale_order_payments
         (sale_order_id, ref_sale_item_id, change_type, amount, payment_method, status, source_end, note, created_at, paid_at)
       VALUES ($1, $2, '回款', $3, '线下', '已支付', 'staff', '寄存单初始化实收', NOW(), NOW())`,
      [orderId, `${orderId}_ITEM_${i + 1}`, rows[i].received],
    )
  }
}

async function fetchItems(orderId) {
  return await pgQuery(
    `SELECT sale_item_id, session_count, remaining_sessions, paid_sessions, received, refunded_quantity
       FROM sale_items WHERE sale_order_id=$1 ORDER BY sale_item_id`, [orderId])
}

async function main() {
  rec(`[smoke-deposit-refund] start | ${new Date().toISOString()}`)
  await cleanupTestData(NS)
  await ensureTestStore()
  await createTestStaff()
  await createTestClient()
  await invalidateStaffAuthCache(TEST_MANAGER_OPENID)

  const errors = []

  // ════════════════ D1 多行寄存单 · 有历史实收 · 部分消耗 ════════════════
  {
    const o = `${NS}_DEPRF_D1`
    // 行 A：10 次 × ¥80（实收 ¥800），已消费 5 次 → 未消耗 5 次，可退 ¥400
    // 行 B： 5 次 × ¥60（实收 ¥300），已消费 0 次 → 未消耗 5 次，可退 ¥300
    await seedDepositOrder(o, [
      { sessionCount: 10, remaining: 5, saleAmount: 1000, received: 800, unitRealPrice: 80 },
      { sessionCount: 5, remaining: 5, saleAmount: 500, received: 300, unitRealPrice: 60 },
    ], { received: 1100 })
    const seeded = await fetchItems(o)
    // 种子态自检：退款的「只退未消耗」口径全靠这三列，写错会让用例以别的方式失败
    for (const r of seeded) {
      if (n2(r.remaining_sessions) !== 5 || n2(r.paid_sessions) !== n2(r.session_count)) {
        errors.push(`D1 种子态异常(${r.sale_item_id}): remaining=${r.remaining_sessions} paid=${r.paid_sessions} sc=${r.session_count}`)
      }
    }
    const ids = seeded.map((r) => r.sale_item_id)

    const cr = await invokeStaffApi('order.createRefund', {
      _testOpenid: TEST_MANAGER_OPENID,
      refSaleOrderId: o,
      items: ids.map((saleItemId) => ({ saleItemId })), // 不带 refundQuantity → 疗程卡整卡可退次数
      refundReason: 'e2e_D1_寄存单退款',
    })
    if (cr.code !== 0) {
      errors.push(`D1 createRefund 应成功（白名单已放开寄存单），实际 code=${cr.code} type=${cr.errorType} msg=${cr.message}`)
    }
    const totalRefund = n2(cr.data?.totalRefund)
    if (cr.code === 0 && Math.abs(totalRefund - 700) > 0.001) {
      errors.push(`D1 totalRefund 应=700（5×80 + 5×60），实际=${totalRefund}`)
    }

    const pid = cr.data?.paymentId
    if (pid) {
      const ap = await invokeStaffApi('order.approveRefund', {
        _testOpenid: TEST_MANAGER_OPENID, paymentId: pid,
      })
      if (ap.code !== 0) {
        errors.push(`D1 approveRefund 应成功（寄存单豁免通道 1），实际 code=${ap.code} type=${ap.errorType} msg=${ap.message}`)
      } else {
        const items = await fetchItems(o)
        const a = items.find((r) => r.sale_item_id === `${o}_ITEM_1`)
        const b = items.find((r) => r.sale_item_id === `${o}_ITEM_2`)
        // 行 A：退 5 次、¥400 → paid 10→5（= 已消费次数）、received 800→400
        if (n2(a?.paid_sessions) !== 5) errors.push(`D1 行A paid_sessions 应=5（10−退5），实际=${a?.paid_sessions}`)
        if (Math.abs(n2(a?.received) - 400) > 0.001) errors.push(`D1 行A received 应=400（800−400），实际=${a?.received}`)
        // 行 B：退 5 次、¥300 → paid 5→0、received 300→0
        if (n2(b?.paid_sessions) !== 0) errors.push(`D1 行B paid_sessions 应=0（5−退5），实际=${b?.paid_sessions}`)
        if (Math.abs(n2(b?.received)) > 0.001) errors.push(`D1 行B received 应=0（300−300），实际=${b?.received}`)

        const ord = (await pgQuery(
          `SELECT refunded_amount, status FROM sale_orders WHERE sale_order_id=$1`, [o]))[0]
        if (Math.abs(n2(ord?.refunded_amount) - 700) > 0.001) errors.push(`D1 refunded_amount 应=700，实际=${ord?.refunded_amount}`)
        // 全部行的可用权益都退光 ⇒ 置「已退款」终态（#543 追加口径）。
        // 关键是**绝不能**被 reconcileOrderStatusAfterRefund 那套「标价快照 vs received」判据误改成
        // 「部分支付」——寄存单不是欠款。
        if (ord?.status !== '已退款') errors.push(`D1 全部行无可用权益后应=已退款，实际='${ord?.status}'`)
        else if (ord?.status === '部分支付') errors.push('D1 状态被误改成「部分支付」（寄存单不是欠款）')

        // 豁免通道 1 的实证：本单不产生任何 receipt
        const rc = (await pgQuery(
          `SELECT COUNT(*)::int AS c FROM sale_payment_item_receipts WHERE sale_order_id=$1`, [o]))[0]
        if (Number(rc?.c) !== 0) errors.push(`D1 寄存单不应产生 sale_payment_item_receipts（通道 1 已豁免），实际=${rc?.c} 行`)

        rec(`  ✅ D1 多行寄存单退款：refunded_amount=700 / paid 10→5 与 5→0 / received 800→400、300→0 / 状态→已退款`)
      }
    }

    // D1-2 二次退款必须被可退数量门拦住（paid_sessions − 已消费 = 0）
    const cr2 = await invokeStaffApi('order.createRefund', {
      _testOpenid: TEST_MANAGER_OPENID,
      refSaleOrderId: o,
      items: ids.map((saleItemId) => ({ saleItemId })),
      refundReason: 'e2e_D1_dup',
    })
    // 二次退款必须被拒。终态落地后先撞「原订单状态不允许退款」这道状态门，退可数量门在状态门之前
    // 也都拦得住；两者都算通过，只断言「不得成功」。
    if (cr2.code === 0) errors.push(`D1-2 二次退款应被拒（状态门或可退数量门），实际成功 paymentId=${cr2.data?.paymentId}（资损！）`)
  }

  // ════════════════ D2 0 元寄存单 · 部分消耗 → 只退次数、金额 0 ════════════════
  {
    const o = `${NS}_DEPRF_D2`
    // 6 次卡、历史实收 0 → unit_real_price 被写成 0；已消费 4 次、未消耗 2 次
    await seedDepositOrder(o, [
      { sessionCount: 6, remaining: 2, saleAmount: 600, received: 0, unitRealPrice: 0 },
    ], { received: 0 })

    const cr = await invokeStaffApi('order.createRefund', {
      _testOpenid: TEST_MANAGER_OPENID,
      refSaleOrderId: o,
      items: [{ saleItemId: `${o}_ITEM_1` }],
      refundReason: 'e2e_D2_零元退次数',
    })
    if (cr.code !== 0) {
      errors.push(`D2 0 元寄存单退款应成功（零元退项闸已放宽），实际 code=${cr.code} type=${cr.errorType} msg=${cr.message}`)
    } else {
      const ap = await invokeStaffApi('order.approveRefund', {
        _testOpenid: TEST_MANAGER_OPENID, paymentId: cr.data?.paymentId,
      })
      if (ap.code !== 0) {
        errors.push(`D2 approveRefund 应成功，实际 code=${ap.code} type=${ap.errorType} msg=${ap.message}`)
      } else {
        const it = (await fetchItems(o))[0]
        if (n2(it?.paid_sessions) !== 4) errors.push(`D2 paid_sessions 应=4（6−退2，只退次数），实际=${it?.paid_sessions}`)
        const ord = (await pgQuery(
          `SELECT refunded_amount, status FROM sale_orders WHERE sale_order_id=$1`, [o]))[0]
        if (Math.abs(n2(ord?.refunded_amount)) > 0.001) errors.push(`D2 refunded_amount 应=0（无钱可退），实际=${ord?.refunded_amount}`)
        // 0 元寄存单退光可用次数同样进「已退款」终态（卡已作废，退款额 0）
        if (ord?.status !== '已退款') errors.push(`D2 可用次数退光后应=已退款，实际='${ord?.status}'`)
        rec(`  ✅ D2 0 元寄存单：只退次数 paid 6→4，金额 0，状态→已退款`)
      }
    }
  }

  // ════════════════ D3 回款仍锁（#543 只放开「退款」） ════════════════
  {
    const o = `${NS}_DEPRF_D3`
    await seedDepositOrder(o, [
      { sessionCount: 5, remaining: 5, saleAmount: 500, received: 300, unitRealPrice: 60 },
    ], { received: 300 })
    const rep = await invokeStaffApi('order.createRepayment', {
      _testOpenid: TEST_MANAGER_OPENID,
      refSaleOrderId: o, paymentMethod: '线下', repayAmount: 100,
    })
    if (rep.code === 0 || rep.errorType !== 'INVALID_STATE' || !/寄存单/.test(rep.message || '')) {
      errors.push(`D3 寄存单回款应被拒 = INVALID_STATE/寄存单，实际 code=${rep.code} type=${rep.errorType} msg=${rep.message}`)
    } else {
      rec(`  ✅ D3 寄存单回款仍被拒`)
    }
  }

  // ════════════════ D4 豁免范围不扩散：多行销售单无 receipt 仍抛残值映射错 ════════════════
  {
    const o = `${NS}_DEPRF_D4`
    await createTestSaleOrder({
      saleOrderId: o, clientUserId: TEST_CLIENT_USER_ID,
      saleOrderType: '销售单', productName: `${NS}_销售卡A`, productType: '疗程卡',
      quantity: 1, sessionCount: 5, totalAmount: 500, status: '已支付', salesCategory: '他销自耗',
    })
    await createTestSaleItem({
      saleOrderId: o, saleItemId: `${o}_ITEM_2`,
      productName: `${NS}_销售卡B`, productType: '疗程卡',
      quantity: 1, unitPrice: 500, sessionCount: 5, salesCategory: '他销自耗',
    })
    await pgQuery(`UPDATE sale_orders SET received=1000 WHERE sale_order_id=$1`, [o])
    await pgQuery(`UPDATE sale_items SET received=500, paid_sessions=5 WHERE sale_order_id=$1`, [o])
    await pgQuery(
      `INSERT INTO sale_order_payments (sale_order_id, change_type, amount, payment_method, status, source_end, created_at, paid_at)
       VALUES ($1, '首次支付', 1000, '线下', '已支付', 'staff', NOW(), NOW())`, [o])

    const cr = await invokeStaffApi('order.createRefund', {
      _testOpenid: TEST_MANAGER_OPENID,
      refSaleOrderId: o,
      items: [{ saleItemId: `${o}_ITEM_1` }, { saleItemId: `${o}_ITEM_2` }],
      refundReason: 'e2e_D4',
    })
    const ap = cr.code === 0
      ? await invokeStaffApi('order.approveRefund', { _testOpenid: TEST_MANAGER_OPENID, paymentId: cr.data?.paymentId })
      : cr
    if (ap.code === 0) {
      errors.push('D4 多行销售单无 receipt 应仍被拒（豁免只对寄存单生效），实际成功')
    } else if (!/无法完整映射到商品行实收/.test(ap.message || '')) {
      // 拒绝理由可以是残值映射（cascade 通道 1）或其它前置门；只要不是靠豁免放行即算通过，
      // 但若不是映射错要显式记出来，避免"恰好被别的门挡住"掩盖豁免被误扩大。
      rec(`  ⚠ D4 被拒但理由非残值映射错：type=${ap.errorType} msg=${ap.message}`)
    } else {
      rec(`  ✅ D4 豁免未扩散（多行销售单无 receipt 仍抛残值映射错）`)
    }
  }

  // ════════════════ D5 驳回无副作用（验收 6） ════════════════
  {
    const o = `${NS}_DEPRF_D5`
    await seedDepositOrder(o, [
      { sessionCount: 8, remaining: 3, saleAmount: 800, received: 500, unitRealPrice: 62.5 },
    ], { received: 500 })
    const before = (await fetchItems(o))[0]

    const cr = await invokeStaffApi('order.createRefund', {
      _testOpenid: TEST_MANAGER_OPENID,
      refSaleOrderId: o,
      items: [{ saleItemId: `${o}_ITEM_1` }],
      refundReason: 'e2e_D5_驳回用',
    })
    if (cr.code !== 0) {
      errors.push(`D5 createRefund 应成功，实际 code=${cr.code} type=${cr.errorType} msg=${cr.message}`)
    } else {
      const rj = await invokeStaffApi('order.rejectRefund', {
        _testOpenid: TEST_MANAGER_OPENID, paymentId: cr.data?.paymentId, auditRemark: 'e2e_D5_驳回',
      })
      if (rj.code !== 0) {
        errors.push(`D5 rejectRefund 应成功，实际 code=${rj.code} type=${rj.errorType} msg=${rj.message}`)
      } else {
        const pay = (await pgQuery(
          `SELECT status, audit_remark FROM sale_order_payments WHERE id=$1`, [cr.data.paymentId]))[0]
        if (pay?.status !== '已作废') errors.push(`D5 退款流水应=已作废，实际='${pay?.status}'`)
        const ord = (await pgQuery(
          `SELECT refunded_amount, status FROM sale_orders WHERE sale_order_id=$1`, [o]))[0]
        if (n2(ord?.refunded_amount) !== 0) errors.push(`D5 refunded_amount 应=0（驳回不累计），实际=${ord?.refunded_amount}`)
        if (ord?.status !== '已支付') errors.push(`D5 订单状态不应变化，实际='${ord?.status}'`)
        const after = (await fetchItems(o))[0]
        for (const col of ['paid_sessions', 'received', 'remaining_sessions']) {
          if (String(after[col]) !== String(before[col])) {
            errors.push(`D5 驳回后 ${col} 不应变化：${before[col]} → ${after[col]}`)
          }
        }
        // 驳回后必须能重新发起（流水唯一约束只挡『待审批』那一笔）
        const again = await invokeStaffApi('order.createRefund', {
          _testOpenid: TEST_MANAGER_OPENID,
          refSaleOrderId: o,
          items: [{ saleItemId: `${o}_ITEM_1` }],
          refundReason: 'e2e_D5_重新发起',
        })
        if (again.code !== 0) errors.push(`D5 驳回后应可重新发起退款，实际 code=${again.code} msg=${again.message}`)
        else rec(`  ✅ D5 驳回无副作用（已作废 / 金额与次数零变化 / 可重新发起）`)
      }
    }
  }

  // ════════════════ D6 家居寄存件退款 → 可提量收敛（验收 3） ════════════════
  {
    const o = `${NS}_DEPRF_D6`
    // 家居行：3 件 × ¥100，寄存单（sale_order_type='寄存单'，session_count IS NULL）
    await createTestSaleOrder({
      saleOrderId: o, clientUserId: TEST_CLIENT_USER_ID,
      saleOrderType: '寄存单', productName: `${NS}_寄存家居`, productType: '家居产品',
      quantity: 3, sessionCount: null, totalAmount: 300, status: '已支付', salesCategory: '他销自耗',
    })
    const itemId = `${o}_ITEM_1`
    await pgQuery(
      `UPDATE sale_orders SET total_amount=0, payable_amount=0, received=300, payment_method='无' WHERE sale_order_id=$1`, [o])
    // 历史实收回款行（定向到行），与真寄存单同形；仍不写 receipt
    await pgQuery(
      `INSERT INTO sale_order_payments
         (sale_order_id, ref_sale_item_id, change_type, amount, payment_method, status, source_end, note, created_at, paid_at)
       VALUES ($1, $2, '回款', 300, '线下', '已支付', 'staff', '寄存单初始化实收', NOW(), NOW())`,
      [o, itemId])

    const available = (row) => n2(row.quantity) - Math.min(
      n2(row.quantity),
      n2(row.picked_up_quantity) + n2(row.refunded_quantity) + n2(row.converted_quantity),
    )
    // 与 pickup-records.ts / staffApi availablePickupItems 的 row_pending_pickup 同式
    // （寄存单分支：quantity − LEAST(quantity, 已提货 + 已退款 + 已转换)）
    const before = (await pgQuery(
      `SELECT quantity, picked_up_quantity, refunded_quantity, converted_quantity, received
         FROM sale_items WHERE sale_item_id=$1`, [itemId]))[0]
    if (available(before) !== 3) errors.push(`D6 种子态可提量应=3，实际=${available(before)}`)

    const cr = await invokeStaffApi('order.createRefund', {
      _testOpenid: TEST_MANAGER_OPENID,
      refSaleOrderId: o,
      items: [{ saleItemId: itemId }],
      refundReason: 'e2e_D6_家居寄存件',
    })
    if (cr.code !== 0) {
      errors.push(`D6 家居寄存件退款应成功，实际 code=${cr.code} type=${cr.errorType} msg=${cr.message}`)
    } else {
      const ap = await invokeStaffApi('order.approveRefund', {
        _testOpenid: TEST_MANAGER_OPENID, paymentId: cr.data?.paymentId,
      })
      if (ap.code !== 0) {
        errors.push(`D6 approveRefund 应成功，实际 code=${ap.code} type=${ap.errorType} msg=${ap.message}`)
      } else {
        const after = (await pgQuery(
          `SELECT quantity, picked_up_quantity, refunded_quantity, converted_quantity
             FROM sale_items WHERE sale_item_id=$1`, [itemId]))[0]
        if (n2(after?.refunded_quantity) !== 3) {
          errors.push(`D6 refunded_quantity 应=3（级联通道 5 累加），实际=${after?.refunded_quantity}`)
        }
        if (available(after) !== 0) errors.push(`D6 可提量应收敛到 0，实际=${available(after)}`)
        const rc = (await pgQuery(
          `SELECT COUNT(*)::int AS c FROM sale_payment_item_receipts WHERE sale_order_id=$1`, [o]))[0]
        if (Number(rc?.c) !== 0) errors.push(`D6 寄存单不应产生 receipt（豁免前提），实际=${rc?.c} 行`)
        const ord6 = (await pgQuery(`SELECT status FROM sale_orders WHERE sale_order_id=$1`, [o]))[0]
        if (ord6?.status !== '已退款') errors.push(`D6 家居件退光后应=已退款，实际='${ord6?.status}'`)
        rec(`  ✅ D6 家居寄存件：refunded_quantity 0→3，可提量 3→0，状态→已退款`)
      }
    }
  }

  // ════════════════ D7 只退其中一行 → 状态不得跳终态（也不得落「部分支付」） ════════════════
  {
    const o = `${NS}_DEPRF_D7`
    // 行 A：6 次 × ¥80（实收 ¥480），已消费 4 次 → 未消耗 2 次
    // 行 B：4 次 × ¥50（实收 ¥200），完全未消耗 → 保持可用
    await seedDepositOrder(o, [
      { sessionCount: 6, remaining: 2, saleAmount: 600, received: 480, unitRealPrice: 80 },
      { sessionCount: 4, remaining: 4, saleAmount: 400, received: 200, unitRealPrice: 50 },
    ], { received: 680 })

    const cr = await invokeStaffApi('order.createRefund', {
      _testOpenid: TEST_MANAGER_OPENID,
      refSaleOrderId: o,
      items: [{ saleItemId: `${o}_ITEM_1` }],   // 只退行 A
      refundReason: 'e2e_D7_部分行',
    })
    if (cr.code !== 0) {
      errors.push(`D7 只退一行的退款应成功，实际 code=${cr.code} type=${cr.errorType} msg=${cr.message}`)
    } else {
      const ap = await invokeStaffApi('order.approveRefund', {
        _testOpenid: TEST_MANAGER_OPENID, paymentId: cr.data?.paymentId,
      })
      if (ap.code !== 0) {
        errors.push(`D7 approveRefund 应成功，实际 code=${ap.code} msg=${ap.message}`)
      } else {
        const items = await fetchItems(o)
        const a = items.find((r) => r.sale_item_id === `${o}_ITEM_1`)
        const b = items.find((r) => r.sale_item_id === `${o}_ITEM_2`)
        if (n2(a?.paid_sessions) !== 4) errors.push(`D7 行A paid 应=4（退光未消耗 2 次），实际=${a?.paid_sessions}`)
        if (n2(b?.paid_sessions) !== 4) errors.push(`D7 行B paid 不应变化（仍 4），实际=${b?.paid_sessions}`)
        const ord = (await pgQuery(`SELECT status FROM sale_orders WHERE sale_order_id=$1`, [o]))[0]
        // 行 B 仍有可用权益 ⇒ 不得进终态；且不得被标价快照判据误改成「部分支付」
        if (ord?.status !== '已支付') errors.push(`D7 仍有可用权益时应保持「已支付」，实际='${ord?.status}'`)
        rec(`  ✅ D7 只退一行：行A 可用归零、行B 不变，状态仍「已支付」（未跳终态、未落部分支付）`)
      }
    }
  }

  if (errors.length) {
    rec(`  ✗ FAIL: ${errors.length} 项断言失败`)
    for (const e of errors) rec(`    - ${e}`)
    return
  }
  pass = true
  exitCode = 0
  rec(`  ✅ PASS — 寄存单退款：白名单放行 / 通道 1 豁免（fail-safe）/ 只退未消耗（次数+金额+家居可提量）/ 全退→已退款终态（部分行不跳终态）/ 驳回无副作用 / 回款仍锁`)
}

try {
  await main()
} catch (e) {
  console.error('[smoke-deposit-refund] EXCEPTION:', e.message)
  if (e?.stack) console.error(e.stack)
} finally {
  try { await cleanupTestData(NS) } catch (e) { console.error('[cleanup error]', e.message) }
  await closePool()
  console.log(`[smoke-deposit-refund] end | ${pass ? 'PASS' : 'FAIL'} | exit=${exitCode}`)
  process.exit(exitCode)
}
