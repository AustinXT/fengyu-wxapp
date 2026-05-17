#!/usr/bin/env bun
/**
 * service.complete 服务提成完整链路冒烟
 *
 * 验证 commission_rate_matrix 通过 (role_type, sales_category, amount_tier) 命中并写入
 * service_commissions 的完整链路 + tier 阶梯切换 + 矩阵未配的兜底。
 *
 * 4 个用例：
 *   1. 基础命中 — 服务单/美容师/他销自耗/tier(0,NULL) rate=0.10
 *   2. tier1 (0-5000) — 服务单/美容师/自销自耗/tier(0,5000) rate=0.12，consumeBase=400
 *   3. tier2 (5000-NULL) — 服务单/美容师/自销自耗/tier(5000,NULL) rate=0.18，consumeBase=6000
 *   4. 兜底未配 — 服务单/美容师/生态合作 矩阵无规则 → rate=0 且写 service.complete.rate_missing 日志
 *
 * 依赖：ensureTestCommissionMatrix() 注入 16 条规则到 TEST_MARKET_ORG_ID
 */
import './setup.mjs'
import {
  NS,
  TEST_MANAGER_EMP_ID, TEST_MANAGER_OPENID, TEST_STORE_ID,
  pgQuery, closePool,
} from './setup.mjs'
import { invokeStaffApi } from './helpers/invoke.mjs'
import {
  ensureTestStore, ensureTestCommissionMatrix,
  createTestStaff, createTestClient, createTestProduct,
  createTestSaleOrder, createTestServiceOrder, cleanupTestData,
} from './helpers/fixtures.mjs'

let pass = false
let exitCode = 1
function rec(line) { console.log(line) }

/**
 * 一次性走完：建销售单→建服务单('服务中')→service.complete→读 service_commissions
 *
 * 注意：每用例独立 clientUserId — service_orders 有 partial unique
 *      `uq_so_client_active(client_user_id) WHERE status IN ('待服务','服务中')`，
 *      多个用例共用同一 client 会冲突。
 */
async function runCase({
  caseName,
  clientUserId,
  skuId,
  unitRealPrice,
  serviceFee,
  salesCategory,
  expectRate,
  expectFixed,
  expectConsume,
  expectCommission,
  expectRateMissing = false,
}) {
  const saleOrderId = `${NS}_SVC_${caseName}_SO`
  const serviceOrderId = `${NS}_SVC_${caseName}_HLD`

  // sessionCount=10 → 单 item 总额 = unitRealPrice × 10；扣 1 次后剩 9 次
  await createTestSaleOrder({
    saleOrderId, clientUserId,
    skuId, productName: `${NS}_${caseName}`, productType: '疗程卡',
    quantity: 1, totalAmount: unitRealPrice * 10,
    status: '已支付', salesCategory,
    sessionCount: 10,
  })
  // sale_items 写入时 unit_price = totalAmount/quantity = unitRealPrice × 10
  // 修正为单次单价，让 service_fee 与 service_items.unit_real_price 一致
  await pgQuery(
    `UPDATE sale_items
       SET unit_price=$2, unit_real_price=$2, sale_amount=$3, received=$3, service_fee=$4
       WHERE sale_order_id=$1`,
    [saleOrderId, unitRealPrice, unitRealPrice * 10, serviceFee]
  )

  // service.complete 内部查 sit.unit_real_price → 必须是单次价
  await createTestServiceOrder({
    serviceOrderId,
    status: '服务中',
    clientUserId,
    items: [{
      saleItemId: `${saleOrderId}_ITEM_1`,
      employeeId: TEST_MANAGER_EMP_ID,    // skills=['美容师']
      sessionUsed: 1,
      unitRealPrice,
      salesCategory,
    }],
  })

  const res = await invokeStaffApi('service.complete', {
    _testOpenid: TEST_MANAGER_OPENID,
    serviceOrderId,
  })

  const errors = []
  if (res.code !== 0) {
    errors.push(`[${caseName}] service.complete 失败 code=${res.code} msg=${res.message}`)
    return { errors }
  }
  if (res.data?.status !== '已完成') {
    errors.push(`[${caseName}] status 应=已完成，实际=${res.data?.status}`)
  }

  const commRows = await pgQuery(
    `SELECT role_type, commission_rate, fixed_fee, consume_amount, commission_amount
       FROM service_commissions
      WHERE service_item_id = $1`,
    [`${serviceOrderId}_I1`]
  )
  if (commRows.length !== 1) {
    errors.push(`[${caseName}] service_commissions 应=1 行，实际=${commRows.length}`)
    return { errors }
  }
  const c = commRows[0]
  if (c.role_type !== '美容师') errors.push(`[${caseName}] role_type 应=美容师，实际=${c.role_type}`)
  if (Math.abs(Number(c.commission_rate) - expectRate) > 0.0001) {
    errors.push(`[${caseName}] commission_rate 应=${expectRate}，实际=${c.commission_rate}`)
  }
  if (Math.abs(Number(c.fixed_fee) - expectFixed) > 0.01) {
    errors.push(`[${caseName}] fixed_fee 应=${expectFixed}，实际=${c.fixed_fee}`)
  }
  if (Math.abs(Number(c.consume_amount) - expectConsume) > 0.01) {
    errors.push(`[${caseName}] consume_amount 应=${expectConsume}，实际=${c.consume_amount}`)
  }
  if (Math.abs(Number(c.commission_amount) - expectCommission) > 0.01) {
    errors.push(`[${caseName}] commission_amount 应=${expectCommission}，实际=${c.commission_amount}`)
  }

  // 检查 service.complete.rate_missing 日志
  const logs = await pgQuery(
    `SELECT COUNT(*)::int AS cnt FROM operation_logs
      WHERE action='service.complete.rate_missing' AND target_id=$1`,
    [`${serviceOrderId}_I1`]
  )
  const logCnt = logs[0].cnt
  if (expectRateMissing && logCnt === 0) {
    errors.push(`[${caseName}] 期望写 rate_missing 日志（rate=0），实际无日志`)
  }
  if (!expectRateMissing && logCnt > 0) {
    errors.push(`[${caseName}] 不应写 rate_missing 日志（rate>0），实际写了 ${logCnt} 条`)
  }

  rec(`  [${caseName}] rate=${c.commission_rate} fixed=${c.fixed_fee} consume=${c.consume_amount} total=${c.commission_amount} log=${logCnt}`)
  return { errors }
}

async function main() {
  rec(`[smoke-service-commission] start | ${new Date().toISOString()}`)

  await cleanupTestData(NS)
  await ensureTestStore()
  await ensureTestCommissionMatrix()

  // 店长（用 manager 调用 service.complete，权限放行）
  await createTestStaff()   // 默认 skills=['美容师']

  // 4 个独立顾客（避开 service_orders.uq_so_client_active 约束）
  const clients = []
  for (let i = 1; i <= 4; i++) {
    const userId = `${NS}_CLI${i}`
    await createTestClient({
      userId,
      openid: `${NS}_CLI${i}_OPENID`,
      phone: `1999909901${i}`,
      name: `${NS}_顾客${i}`,
    })
    clients.push(userId)
  }

  // SKU 准备
  // 注意：createTestProduct 的 salesCategory 决定 product_categories.sales_category；
  // createTestSaleOrder 直接传 salesCategory 写入 sale_items.sales_category 快照
  const skuA = await createTestProduct({
    suffix: 'SVC_A',
    productKind: '护理项目', productType: '疗程卡',
    salesCategory: '他销自耗', price: 1000, sessionCount: 10,
    serviceFee: 20, isShengmei: true,
  })
  const skuB = await createTestProduct({
    suffix: 'SVC_B',
    productKind: '护理项目', productType: '疗程卡',
    salesCategory: '自销自耗', price: 60000, sessionCount: 10,
    serviceFee: 0, isShengmei: true,
  })
  const skuC = await createTestProduct({
    suffix: 'SVC_C',
    productKind: '护理项目', productType: '疗程卡',
    salesCategory: '生态合作', price: 1000, sessionCount: 10,
    serviceFee: 20, isShengmei: true,
  })

  const allErrors = []

  // 用例 1：基础命中 服务单/美容师/他销自耗/tier(0,NULL) rate=0.10
  const r1 = await runCase({
    caseName: 'CASE1',
    clientUserId: clients[0],
    skuId: skuA.skuId,
    unitRealPrice: 100,
    serviceFee: 20,
    salesCategory: '他销自耗',
    expectRate: 0.10,
    expectFixed: 20.00,    // 20 × 1
    expectConsume: 10.00,  // 100 × 1 × 0.10
    expectCommission: 30.00,
  })
  allErrors.push(...r1.errors)

  // 用例 2：tier1 (0-5000) 服务单/美容师/自销自耗 rate=0.12，consumeBase=400
  const r2 = await runCase({
    caseName: 'CASE2',
    clientUserId: clients[1],
    skuId: skuB.skuId,
    unitRealPrice: 400,
    serviceFee: 0,
    salesCategory: '自销自耗',
    expectRate: 0.12,
    expectFixed: 0.00,
    expectConsume: 48.00,   // 400 × 1 × 0.12
    expectCommission: 48.00,
  })
  allErrors.push(...r2.errors)

  // 用例 3：tier2 (5000-NULL) 服务单/美容师/自销自耗 rate=0.18，consumeBase=6000
  const r3 = await runCase({
    caseName: 'CASE3',
    clientUserId: clients[2],
    skuId: skuB.skuId,
    unitRealPrice: 6000,
    serviceFee: 0,
    salesCategory: '自销自耗',
    expectRate: 0.18,
    expectFixed: 0.00,
    expectConsume: 1080.00,  // 6000 × 1 × 0.18
    expectCommission: 1080.00,
  })
  allErrors.push(...r3.errors)

  // 用例 4：兜底未配 服务单/美容师/生态合作 矩阵无规则 → rate=0 + 日志
  const r4 = await runCase({
    caseName: 'CASE4',
    clientUserId: clients[3],
    skuId: skuC.skuId,
    unitRealPrice: 100,
    serviceFee: 20,
    salesCategory: '生态合作',
    expectRate: 0,
    expectFixed: 20.00,
    expectConsume: 0,
    expectCommission: 20.00,  // fixed_fee = 20
    expectRateMissing: true,
  })
  allErrors.push(...r4.errors)

  if (allErrors.length) {
    rec(`  ✗ FAIL: ${allErrors.length} 项断言失败`)
    for (const e of allErrors) rec(`    - ${e}`)
    return
  }

  pass = true
  exitCode = 0
  rec(`  ✅ PASS — 4 用例全过：sales_category 命中 + tier 阶梯切换 + 矩阵未配兜底`)
}

try {
  await main()
} catch (e) {
  console.error('[smoke-service-commission] EXCEPTION:', e.message)
  if (e?.stack) console.error(e.stack)
} finally {
  try { await cleanupTestData(NS) } catch (e) { console.error('[cleanup error]', e.message) }
  await closePool()
  console.log(`[smoke-service-commission] end | ${pass ? 'PASS' : 'FAIL'} | exit=${exitCode}`)
  process.exit(exitCode)
}
