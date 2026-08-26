#!/usr/bin/env bun
/**
 * order.list 列表冒烟（门店视图 / 状态过滤）
 *
 * L1 缺口：__tests__/routes/order.test.js 的 order.list describe 全程 mock pg.query，
 * 只断言 SQL 字符串 + params，**从不执行真实 SQL**，因此测不出「枚举列 vs text[] 操作符」
 * 这类运行期 SQL 语义错误。
 *
 * 守护的 bug（回归，commit 1fb5e4bd 2026-06-01 引入）：
 *   「待支付」tab 把状态合并查询写成 `o.status = ANY($N::text[])`，但 sale_orders.status
 *   是 order_status 枚举类型 → `order_status = ANY(text[])` 需要不存在的 `order_status = text`
 *   操作符 → 计划期即报 `operator does not exist: order_status = text`（空表也炸）→ 被全局
 *   catch 兜底成 code -1「服务器内部错误」。修复：`ANY($N::order_status[])`。
 *
 * 守护点：
 *   1. order.list {status:'待支付'} → code 0（修前必回 -1）；且合并「部分支付」（待支付 tab
 *      语义 = 待支付 + 部分支付，二者都属未结清），不含已支付。← 核心回归点
 *   2. order.list {status:'已支付'} → code 0，含已支付、不含待支付/部分支付。
 *   3. order.list {} 无 status → code 0，四张单全在。
 *   4. order.list 返回 allocatable 字段：销售单=true / 寄存单=false（控制列表页「营业额分配」按钮显隐，与 order.detail 同口径）。
 */
import './setup.mjs'
import {
  NS,
  TEST_MANAGER_OPENID,
  TEST_STORE_ID,
  TEST_CLIENT_USER_ID,
  closePool,
} from './setup.mjs'
import { invokeStaffApi } from './helpers/invoke.mjs'
import {
  ensureTestStore, createTestStaff, createTestClient,
  createTestSaleOrder, cleanupTestData,
} from './helpers/fixtures.mjs'

let pass = false
let exitCode = 1
function rec(line) { console.log(line) }

const ORDER_PEND = `${NS}_OL_PEND`
const ORDER_PART = `${NS}_OL_PART`
const ORDER_PAID = `${NS}_OL_PAID`
const ORDER_DEPOSIT = `${NS}_OL_DEPOSIT`

async function main() {
  rec(`[smoke-order-list] start | ${new Date().toISOString()}`)

  await cleanupTestData(NS)
  await ensureTestStore()
  await createTestStaff()       // manager（默认店 TEST_STORE_ID，openid=TEST_MANAGER_OPENID）
  await createTestClient()      // 顾客（bound_store_id=TEST_STORE_ID）

  // 三张单：待支付 / 部分支付 / 已支付（均挂在 TEST_STORE_ID）
  await createTestSaleOrder({ saleOrderId: ORDER_PEND, clientUserId: TEST_CLIENT_USER_ID, status: '待支付' })
  await createTestSaleOrder({ saleOrderId: ORDER_PART, clientUserId: TEST_CLIENT_USER_ID, status: '部分支付' })
  await createTestSaleOrder({ saleOrderId: ORDER_PAID, clientUserId: TEST_CLIENT_USER_ID, status: '已支付' })
  // 寄存单（已支付）：验证 allocatable=false —— 列表页不显示「营业额分配」按钮
  await createTestSaleOrder({ saleOrderId: ORDER_DEPOSIT, clientUserId: TEST_CLIENT_USER_ID, status: '已支付', saleOrderType: '寄存单' })

  const errors = []
  // 门店视图：显式指定当前门店（与员工端 cloud.ts 自动附加 _currentStoreId/_loginLevel 一致）
  const storeCtx = { _testOpenid: TEST_MANAGER_OPENID, _loginLevel: 'store', _currentStoreId: TEST_STORE_ID }
  const idsOf = (res) => (res.data?.orders || []).map(o => o.sale_order_id)

  // ─── 1. 待支付 tab（核心回归点：枚举合并 待支付+部分支付）───
  const pending = await invokeStaffApi('order.list', {
    ...storeCtx, status: '待支付', keyword: NS,
    startDate: '2000-01-01', endDate: '2100-12-31', page: 1, pageSize: 50,
  })
  if (pending.code !== 0) {
    errors.push(`order.list(待支付) 应 code 0，实际 code=${pending.code} msg=${pending.message}（回归：::text[] vs 枚举列）`)
  } else {
    const ids = idsOf(pending)
    if (!ids.includes(ORDER_PEND)) errors.push(`待支付结果应含待支付单 ${ORDER_PEND}，实际=${JSON.stringify(ids)}`)
    if (!ids.includes(ORDER_PART)) errors.push(`待支付 tab 应合并「部分支付」单 ${ORDER_PART}，实际=${JSON.stringify(ids)}`)
    if (ids.includes(ORDER_PAID)) errors.push(`待支付结果不该含已支付单 ${ORDER_PAID}`)
    if (!errors.length) rec(`  ✓ order.list(待支付) code 0，含待支付+部分支付、不含已支付`)
  }

  // ─── 2. 已支付 tab（单值枚举过滤）───
  const paid = await invokeStaffApi('order.list', { ...storeCtx, status: '已支付', page: 1, pageSize: 50 })
  if (paid.code !== 0) {
    errors.push(`order.list(已支付) 应 code 0，实际 code=${paid.code} msg=${paid.message}`)
  } else {
    const ids = idsOf(paid)
    if (!ids.includes(ORDER_PAID)) errors.push(`已支付结果应含已支付单 ${ORDER_PAID}`)
    if (ids.includes(ORDER_PEND) || ids.includes(ORDER_PART)) errors.push(`已支付结果不该含待支付/部分支付单`)
    else rec(`  ✓ order.list(已支付) code 0，仅含已支付`)
  }

  // ─── 3. 全部 tab（无 status）+ allocatable 字段口径 ───
  const all = await invokeStaffApi('order.list', { ...storeCtx, page: 1, pageSize: 50 })
  if (all.code !== 0) {
    errors.push(`order.list(全部) 应 code 0，实际 code=${all.code} msg=${all.message}`)
  } else {
    const ids = idsOf(all)
    const missing = [ORDER_PEND, ORDER_PART, ORDER_PAID, ORDER_DEPOSIT].filter(id => !ids.includes(id))
    if (missing.length) errors.push(`全部结果应含四张单，缺=${JSON.stringify(missing)}`)
    else rec(`  ✓ order.list(全部) code 0，四张单全在`)

    // allocatable：销售单可分配 / 寄存单不可分配（控制列表页「营业额分配」按钮显隐，与 order.detail 同口径）
    const orderById = (id) => (all.data?.orders || []).find(o => o.sale_order_id === id)
    const sale = orderById(ORDER_PAID)
    const deposit = orderById(ORDER_DEPOSIT)
    if (sale && sale.allocatable !== true) errors.push(`销售单 ${ORDER_PAID} allocatable 应为 true，实际=${JSON.stringify(sale.allocatable)}`)
    if (deposit && deposit.allocatable !== false) errors.push(`寄存单 ${ORDER_DEPOSIT} allocatable 应为 false，实际=${JSON.stringify(deposit.allocatable)}`)
    if (sale?.allocatable === true && deposit?.allocatable === false) rec(`  ✓ allocatable：销售单 true / 寄存单 false`)
  }

  if (errors.length) {
    rec(`  ✗ FAIL: ${errors.length} 项断言失败`)
    for (const e of errors) rec(`    - ${e}`)
    return
  }

  pass = true
  exitCode = 0
  rec(`  ✅ PASS — order.list 待支付(合并部分支付)/已支付/全部 三态均 code 0`)
}

try {
  await main()
} catch (e) {
  console.error('[smoke-order-list] EXCEPTION:', e.message)
  if (e?.stack) console.error(e.stack)
} finally {
  try { await cleanupTestData(NS) } catch (e) { console.error('[cleanup error]', e.message) }
  await closePool()
  console.log(`[smoke-order-list] end | ${pass ? 'PASS' : 'FAIL'} | exit=${exitCode}`)
  process.exit(exitCode)
}
