#!/usr/bin/env bun
/**
 * allocation.suggestPayment 冒烟（按回款逐笔分配，spai 模型）
 *
 * 验证：
 *   A. 单 SKU + 单 sales_category，双 skill 员工 → 每个 skill 1 条 allocLine，
 *      rate 来自 commission_rate_matrix（按本次回款额 eventAmount 查档），allocationRatio 默认 1.00
 *      + candidateEmployees / orderStoreId / beauticianRequired 字段下发
 *   B. 多 SKU + 多 sales_category 同回款 → 每个 sale_item 各 1 条 allocLine，
 *      rate 按 sales_category 切换，allocationRatio 默认 1.00
 *   C. 脏 market_name 修正（store_id 反查为权威市场）→ ratesByRole 非空、commissionRate>0
 *   D. tier 阶梯切换 → 同 sales_category 不同 eventAmount 命中不同 tier rate
 *   E. allocation.pendingPayments（按回款粒度）字段完整性 + 非法 allocationStatus 拒
 *   F. allocation.rates（提成矩阵，未改名）字段完整性 + 不存在市场拒
 *
 * 依赖：ensureTestCommissionMatrix() 注入规则到 TEST_MARKET_ORG_ID（name=`${NS}_市场`）
 *      （销售单 自销自耗 拆 tier(0,5000)=0.08 + tier(5000,NULL)=0.10）
 *
 * 新模型 fixture：每张订单造一笔待分配回款 + sale_payment_allocatable_items 行（基数 amount），
 *   suggestPayment 以 salePaymentId 为粒度；eventAmount = Σ spai.amount（提成档位基准）。
 */
import './setup.mjs'
import {
  NS,
  TEST_MANAGER_EMP_ID, TEST_MANAGER_OPENID, TEST_CLIENT_USER_ID,
  pgQuery, closePool,
} from './setup.mjs'
import { invokeStaffApi } from './helpers/invoke.mjs'
import {
  ensureTestStore, ensureTestCommissionMatrix,
  createTestStaff, createTestClient, createTestProduct,
  createTestSaleOrder, createTestSaleItem, cleanupTestData,
} from './helpers/fixtures.mjs'

let pass = false
let exitCode = 1
function rec(line) { console.log(line) }

/**
 * 造一笔待分配回款 + 每项一行 spai（可分配基数）。返回 salePaymentId。
 * items: [{ saleItemId, amount, salesCategory }]
 */
async function createPaymentWithSpai({ saleOrderId, items, amount }) {
  const payRows = await pgQuery(
    `INSERT INTO sale_order_payments (
       sale_order_id, change_type, amount, payment_method, status, source_end,
       operator_employee_id, paid_at, allocation_status, created_at
     )
     VALUES ($1, '首次支付'::payment_change_type, $2, '线下'::payment_method,
             '已支付'::payment_flow_status, 'staff'::payment_source_end,
             $3, NOW(), '待分配'::allocation_status, NOW())
     RETURNING id`,
    [saleOrderId, amount, TEST_MANAGER_EMP_ID]
  )
  const paymentId = payRows[0].id
  for (const it of items) {
    await pgQuery(
      `INSERT INTO sale_payment_allocatable_items
         (sale_payment_id, sale_order_id, sale_item_id, amount, sales_category, created_at)
       VALUES ($1, $2, $3, $4, $5::sales_category, NOW())`,
      [paymentId, saleOrderId, it.saleItemId, it.amount, it.salesCategory]
    )
  }
  return paymentId
}

/** 取订单首个 sale_item_id（createTestSaleOrder 生成 `${order}_ITEM_1`） */
async function firstItemId(saleOrderId) {
  const rows = await pgQuery(`SELECT sale_item_id FROM sale_items WHERE sale_order_id = $1 ORDER BY sale_item_id LIMIT 1`, [saleOrderId])
  return rows[0].sale_item_id
}

async function main() {
  rec(`[smoke-alloc-suggest] start | ${new Date().toISOString()}`)

  await cleanupTestData(NS)
  await ensureTestStore()
  await ensureTestCommissionMatrix()

  // 店长（调用者）
  await createTestStaff()
  // 美容师 + 养生师双 skill 员工（用例 A）
  await createTestStaff({
    employeeId: `${NS}_BEAU`,
    openid: `${NS}_BEAU_OPENID`,
    phone: '19999098005',
    name: `${NS}_美养双技`,
    isManager: false,
    positionName: '美容师',
    skills: ['美容师', '养生师'],
  })
  // 单 skill 美容师（用例 B、C、D）
  await createTestStaff({
    employeeId: `${NS}_BEAU_SOLO`,
    openid: `${NS}_BEAU_SOLO_OPENID`,
    phone: '19999098007',
    name: `${NS}_美容师单技`,
    isManager: false,
    positionName: '美容师',
    skills: ['美容师'],
  })
  await createTestClient()

  // SKU 准备：A/C 用 他销自耗 / B 用 自销自耗 + 他销他耗 / D 用 自销自耗
  const skuA = await createTestProduct({
    suffix: 'ALLOC_A',
    productKind: '家居产品', productType: '家居产品',
    salesCategory: '他销自耗', price: 500,
    sessionCount: null, isShengmei: false,
  })
  const skuB1 = await createTestProduct({
    suffix: 'ALLOC_B1',
    productKind: '家居产品', productType: '家居产品',
    salesCategory: '自销自耗', price: 200,
    sessionCount: null, isShengmei: false,
  })
  const skuB2 = await createTestProduct({
    suffix: 'ALLOC_B2',
    productKind: '家居产品', productType: '家居产品',
    salesCategory: '他销他耗', price: 300,
    sessionCount: null, isShengmei: false,
  })

  const errors = []

  // ─── 用例 A：单 SKU 单 sales_category，双 skill 员工 ───
  const orderA = `${NS}_SUG_A`
  await createTestSaleOrder({
    saleOrderId: orderA, clientUserId: TEST_CLIENT_USER_ID,
    skuId: skuA.skuId, productName: skuA.specName,
    productType: '家居产品', quantity: 1, totalAmount: 500,
    status: '已支付', salesCategory: '他销自耗',
    preferredEmployeeId: `${NS}_BEAU`,
  })
  await pgQuery(`UPDATE sale_orders SET allocation_status = '待分配', received = total_amount WHERE sale_order_id = $1`, [orderA])
  const itemA = await firstItemId(orderA)
  const payA = await createPaymentWithSpai({
    saleOrderId: orderA, amount: 500,
    items: [{ saleItemId: itemA, amount: 500, salesCategory: '他销自耗' }],
  })

  const sugA = await invokeStaffApi('allocation.suggestPayment', {
    _testOpenid: TEST_MANAGER_OPENID,
    salePaymentId: payA,
  })
  if (sugA.code !== 0) {
    errors.push(`A.suggest 应成功 实际 code=${sugA.code} msg=${sugA.message}`)
  } else {
    const lines = sugA.data.allocLines || []
    rec(`  A: ${lines.length} allocLines (双 skill × 1 item)`)
    if (lines.length !== 2) errors.push(`A.allocLines 应=2，实际=${lines.length}`)
    for (const l of lines) {
      if (l.salesCategory !== '他销自耗') errors.push(`A.salesCategory 应=他销自耗，实际=${l.salesCategory}`)
      const rate = Number(l.commissionRate)
      if (Math.abs(rate - 0.06) > 0.0001) errors.push(`A.${l.roleType}.rate 应=0.06，实际=${rate}`)
      if (Math.abs(Number(l.allocationRatio) - 1.00) > 0.0001) errors.push(`A.${l.roleType}.allocationRatio 应=1.00，实际=${l.allocationRatio}`)
    }
    const roles = new Set(lines.map(l => l.roleType))
    if (!roles.has('美容师') || !roles.has('养生师')) {
      errors.push(`A.roles 应含 {美容师,养生师}，实际={${[...roles].join(',')}}`)
    }
    if (sugA.data.beauticianRequired !== true) errors.push(`A.beauticianRequired 应=true`)
    if (sugA.data.deptAnomalous === true) errors.push(`A.deptAnomalous 应=false`)
    // 候选员工 + 订单门店（admin 式按技能筛选用）
    if (!Array.isArray(sugA.data.candidateEmployees)) errors.push(`A.candidateEmployees 应为数组`)
    if (!sugA.data.orderStoreId) errors.push(`A.orderStoreId 应非空`)
  }

  // ─── 用例 B：多 SKU 多 sales_category 同回款 ───
  const orderB = `${NS}_SUG_B`
  await createTestSaleOrder({
    saleOrderId: orderB, clientUserId: TEST_CLIENT_USER_ID,
    skuId: skuB1.skuId, productName: skuB1.specName,
    productType: '家居产品', quantity: 1, totalAmount: 200,
    status: '已支付', salesCategory: '自销自耗',
    preferredEmployeeId: `${NS}_BEAU_SOLO`,
  })
  const itemB1 = await firstItemId(orderB)
  // 追加第二个 sale_item，salesCategory=他销他耗
  const itemB2 = `${orderB}_ITEM_2`
  await createTestSaleItem({
    saleOrderId: orderB,
    saleItemId: itemB2,
    skuId: skuB2.skuId,
    productName: skuB2.specName,
    productType: '家居产品',
    quantity: 1,
    unitPrice: 300,
    salesCategory: '他销他耗',
  })
  await pgQuery(`UPDATE sale_orders SET total_amount = 500, allocation_status = '待分配', received = total_amount WHERE sale_order_id = $1`, [orderB])
  const payB = await createPaymentWithSpai({
    saleOrderId: orderB, amount: 500,
    items: [
      { saleItemId: itemB1, amount: 200, salesCategory: '自销自耗' },
      { saleItemId: itemB2, amount: 300, salesCategory: '他销他耗' },
    ],
  })

  const sugB = await invokeStaffApi('allocation.suggestPayment', {
    _testOpenid: TEST_MANAGER_OPENID,
    salePaymentId: payB,
  })
  if (sugB.code !== 0) {
    errors.push(`B.suggest 应成功 实际 code=${sugB.code} msg=${sugB.message}`)
  } else {
    const lines = sugB.data.allocLines || []
    rec(`  B: ${lines.length} allocLines (单 skill × 2 items)`)
    if (lines.length !== 2) errors.push(`B.allocLines 应=2，实际=${lines.length}`)
    const byCat = Object.fromEntries(lines.map(l => [l.salesCategory, l]))
    const l1 = byCat['自销自耗']
    const l2 = byCat['他销他耗']
    if (!l1) errors.push(`B 缺少 自销自耗 allocLine`)
    else {
      if (Math.abs(Number(l1.commissionRate) - 0.08) > 0.0001) errors.push(`B.自销自耗.rate 应=0.08，实际=${l1.commissionRate}`)
      if (Math.abs(Number(l1.allocationRatio) - 1.00) > 0.0001) errors.push(`B.自销自耗.allocationRatio 应=1.00，实际=${l1.allocationRatio}`)
    }
    if (!l2) errors.push(`B 缺少 他销他耗 allocLine`)
    else {
      if (Math.abs(Number(l2.commissionRate) - 0.05) > 0.0001) errors.push(`B.他销他耗.rate 应=0.05，实际=${l2.commissionRate}`)
      if (Math.abs(Number(l2.allocationRatio) - 1.00) > 0.0001) errors.push(`B.他销他耗.allocationRatio 应=1.00，实际=${l2.allocationRatio}`)
    }
  }

  // ─── 用例 C：market_name 快照脏值修正（store_id 反查为权威市场）───
  const orderC = `${NS}_SUG_C`
  await createTestSaleOrder({
    saleOrderId: orderC, clientUserId: TEST_CLIENT_USER_ID,
    skuId: skuA.skuId, productName: skuA.specName,
    productType: '家居产品', quantity: 1, totalAmount: 500,
    status: '已支付', salesCategory: '他销自耗',
    preferredEmployeeId: `${NS}_BEAU_SOLO`,
  })
  // 把订单 market_name 改成不存在的市场（模拟开单人登录态快照脏/空）。
  // suggestPayment 已弃用 market_name 快照、改以 store_id 反查 org 树定位真实市场（TE2LS_市场），
  // 故仍命中提成矩阵——验证脏 market_name 不再导致候选员工/提成查空。
  await pgQuery(
    `UPDATE sale_orders SET market_name='${NS}_不存在市场', allocation_status='待分配', received=total_amount WHERE sale_order_id=$1`,
    [orderC]
  )
  const itemC = await firstItemId(orderC)
  const payC = await createPaymentWithSpai({
    saleOrderId: orderC, amount: 500,
    items: [{ saleItemId: itemC, amount: 500, salesCategory: '他销自耗' }],
  })

  const sugC = await invokeStaffApi('allocation.suggestPayment', {
    _testOpenid: TEST_MANAGER_OPENID,
    salePaymentId: payC,
  })
  if (sugC.code !== 0) {
    errors.push(`C.suggest 应成功 实际 code=${sugC.code} msg=${sugC.message}`)
  } else {
    const lines = sugC.data.allocLines || []
    const ratesByRole = sugC.data.ratesByRole || {}
    const rolesCount = Object.keys(ratesByRole).length
    rec(`  C: ratesByRole=${rolesCount} 个角色 allocLines=${lines.length} (store_id 反查修正脏 market_name)`)
    if (rolesCount === 0) errors.push(`C.ratesByRole 应>0（store_id 反查真实市场、命中矩阵；脏 market_name 不再致空），实际=${rolesCount}`)
    if (lines.length !== 1) errors.push(`C.allocLines 应=1（单 skill），实际=${lines.length}`)
    if (lines.length > 0) {
      const rate = Number(lines[0].commissionRate)
      if (rate <= 0) errors.push(`C.commRate 应>0（反查市场命中矩阵规则），实际=${rate}`)
      if (Math.abs(Number(lines[0].allocationRatio) - 1.00) > 0.0001) errors.push(`C.allocationRatio 应=1.00，实际=${lines[0].allocationRatio}`)
    }
  }

  // ─── 用例 D：销售单 tier 阶梯切换（eventAmount = Σ spai.amount）───
  // 自销自耗 tier(0,5000)=0.08 + tier(5000,NULL)=0.10
  // D1 小额回款 2000 → 命中 tier1 rate=0.08
  // D2 大额回款 8000 → 命中 tier2 rate=0.10
  const skuD = await createTestProduct({
    suffix: 'ALLOC_D',
    productKind: '家居产品', productType: '家居产品',
    salesCategory: '自销自耗', price: 2000,
    sessionCount: null, isShengmei: false,
  })

  const orderD1 = `${NS}_SUG_D1`
  await createTestSaleOrder({
    saleOrderId: orderD1, clientUserId: TEST_CLIENT_USER_ID,
    skuId: skuD.skuId, productName: skuD.specName,
    productType: '家居产品', quantity: 1, totalAmount: 2000,
    status: '已支付', salesCategory: '自销自耗',
    preferredEmployeeId: `${NS}_BEAU_SOLO`,
  })
  await pgQuery(`UPDATE sale_orders SET allocation_status='待分配', received=total_amount WHERE sale_order_id=$1`, [orderD1])
  const itemD1 = await firstItemId(orderD1)
  const payD1 = await createPaymentWithSpai({
    saleOrderId: orderD1, amount: 2000,
    items: [{ saleItemId: itemD1, amount: 2000, salesCategory: '自销自耗' }],
  })

  const sugD1 = await invokeStaffApi('allocation.suggestPayment', {
    _testOpenid: TEST_MANAGER_OPENID,
    salePaymentId: payD1,
  })
  if (sugD1.code !== 0) {
    errors.push(`D1.suggest 应成功 实际 code=${sugD1.code} msg=${sugD1.message}`)
  } else {
    const lines = sugD1.data.allocLines || []
    rec(`  D1: eventAmount=2000 allocLines=${lines.length} (tier1 切换)`)
    if (lines.length !== 1) errors.push(`D1.allocLines 应=1，实际=${lines.length}`)
    if (lines.length > 0) {
      const rate = Number(lines[0].commissionRate)
      if (Math.abs(rate - 0.08) > 0.0001) errors.push(`D1.rate 应=0.08（tier1），实际=${rate}`)
      if (Math.abs(Number(lines[0].allocationRatio) - 1.00) > 0.0001) errors.push(`D1.allocationRatio 应=1.00，实际=${lines[0].allocationRatio}`)
    }
  }

  const orderD2 = `${NS}_SUG_D2`
  await createTestSaleOrder({
    saleOrderId: orderD2, clientUserId: TEST_CLIENT_USER_ID,
    skuId: skuD.skuId, productName: skuD.specName,
    productType: '家居产品', quantity: 1, totalAmount: 8000,
    status: '已支付', salesCategory: '自销自耗',
    preferredEmployeeId: `${NS}_BEAU_SOLO`,
  })
  await pgQuery(`UPDATE sale_orders SET allocation_status='待分配', received=total_amount WHERE sale_order_id=$1`, [orderD2])
  const itemD2 = await firstItemId(orderD2)
  const payD2 = await createPaymentWithSpai({
    saleOrderId: orderD2, amount: 8000,
    items: [{ saleItemId: itemD2, amount: 8000, salesCategory: '自销自耗' }],
  })

  const sugD2 = await invokeStaffApi('allocation.suggestPayment', {
    _testOpenid: TEST_MANAGER_OPENID,
    salePaymentId: payD2,
  })
  if (sugD2.code !== 0) {
    errors.push(`D2.suggest 应成功 实际 code=${sugD2.code} msg=${sugD2.message}`)
  } else {
    const lines = sugD2.data.allocLines || []
    rec(`  D2: eventAmount=8000 allocLines=${lines.length} (tier2 切换)`)
    if (lines.length !== 1) errors.push(`D2.allocLines 应=1，实际=${lines.length}`)
    if (lines.length > 0) {
      const rate = Number(lines[0].commissionRate)
      if (Math.abs(rate - 0.10) > 0.0001) errors.push(`D2.rate 应=0.10（tier2），实际=${rate}`)
      if (Math.abs(Number(lines[0].allocationRatio) - 1.00) > 0.0001) errors.push(`D2.allocationRatio 应=1.00，实际=${lines[0].allocationRatio}`)
    }
  }

  // ─── E. allocation.pendingPayments — 复用 A/B/C/D 的待分配回款（allocation_status='待分配'）───
  const pendR = await invokeStaffApi('allocation.pendingPayments', {
    _testOpenid: TEST_MANAGER_OPENID,
    allocationStatus: '待分配',
    keyword: NS,
    startDate: '2000-01-01', endDate: '2100-12-31',
    page: 1, pageSize: 50,
  })
  if (pendR.code !== 0) {
    errors.push(`allocation.pendingPayments 应成功，实际 code=${pendR.code} msg=${pendR.message}`)
  } else {
    const payments = pendR.data?.payments || []
    const nsPayments = payments.filter(p => String(p.sale_order_id || '').startsWith(NS))
    if (nsPayments.length === 0) {
      errors.push(`pendingPayments(待分配) 应含 NS 前缀回款（fixture 已造待分配 payment），实际 0 条`)
    } else {
      const p0 = nsPayments[0]
      // 字段完整性（routes/allocation.js pendingPayments SELECT）
      for (const k of ['sale_payment_id', 'sale_order_id', 'change_type', 'amount', 'payment_method',
                       'allocation_status', 'customer_name', 'client_phone', 'sale_order_type', 'total_amount']) {
        if (!(k in p0)) errors.push(`pendingPayments row 缺字段 '${k}'`)
      }
      rec(`  ✓ allocation.pendingPayments: ${nsPayments.length} 笔 NS 待分配回款`)
    }
  }

  // pendingPayments(allocationStatus='非法值') → INVALID_PARAMS
  const pendBadR = await invokeStaffApi('allocation.pendingPayments', {
    _testOpenid: TEST_MANAGER_OPENID,
    allocationStatus: '不存在',
  })
  if (pendBadR.code === 0) errors.push(`pendingPayments(非法 allocationStatus) 应 INVALID_PARAMS，实际成功`)

  // ─── F. allocation.rates — 用 NS 市场名（未改名）───
  const ratesR = await invokeStaffApi('allocation.rates', {
    _testOpenid: TEST_MANAGER_OPENID,
    marketName: `${NS}_市场`,
  })
  if (ratesR.code !== 0) {
    errors.push(`allocation.rates(${NS}_市场) 应成功（ensureTestCommissionMatrix 已注入规则），实际 code=${ratesR.code} msg=${ratesR.message}`)
  } else {
    const rates = ratesR.data?.rates || []
    if (rates.length === 0) {
      errors.push(`allocation.rates 应返回 ≥1 行 rate 配置，实际 0`)
    } else {
      const r0 = rates[0]
      for (const k of ['department', 'amountMin', 'amountMax', 'orderRates', 'serviceRates']) {
        if (!(k in r0)) errors.push(`rates[0] 缺字段 '${k}'`)
      }
      rec(`  ✓ allocation.rates(${NS}_市场): ${rates.length} 行 × {department,tier,orderRates,serviceRates}`)
    }
  }

  // rates(marketName=不存在) → INVALID_PARAMS
  const ratesBadR = await invokeStaffApi('allocation.rates', {
    _testOpenid: TEST_MANAGER_OPENID,
    marketName: `${NS}_不存在`,
  })
  if (ratesBadR.code === 0) errors.push(`rates(不存在市场) 应 INVALID_PARAMS，实际成功`)

  if (errors.length) {
    rec(`  ✗ FAIL: ${errors.length} 项断言失败`)
    for (const e of errors) rec(`    - ${e}`)
    return
  }

  pass = true
  exitCode = 0
  rec(`  ✅ PASS — A/B/C/D + pendingPayments/rates 6 路径全过`)
}

try {
  await main()
} catch (e) {
  console.error('[smoke-alloc-suggest] EXCEPTION:', e.message)
  if (e?.stack) console.error(e.stack)
} finally {
  try { await cleanupTestData(NS) } catch (e) { console.error('[cleanup error]', e.message) }
  await closePool()
  console.log(`[smoke-alloc-suggest] end | ${pass ? 'PASS' : 'FAIL'} | exit=${exitCode}`)
  process.exit(exitCode)
}
