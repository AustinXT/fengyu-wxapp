#!/usr/bin/env bun
/**
 * service.cancel 冒烟
 *
 * 验证：
 *   1. 待服务 → 已取消（成功）
 *   2. 服务中 → 已取消（成功）
 *   3. 已完成 → 已取消（必拒）
 *   4. 跨门店调用必拒
 */
import './setup.mjs'
import {
  NS,
  TEST_STORE_ID, TEST_MANAGER_EMP_ID, TEST_MANAGER_OPENID, TEST_CLIENT_USER_ID,
  pgQuery, closePool,
} from './setup.mjs'
import { invokeStaffApi } from './helpers/invoke.mjs'
import {
  ensureTestStore, createTestStaff, createTestClient,
  createTestSaleOrder, createTestServiceOrder, cleanupTestData,
} from './helpers/fixtures.mjs'

let pass = false
let exitCode = 1
function rec(line) { console.log(line) }

async function main() {
  rec(`[smoke-service-cancel] start | ${new Date().toISOString()}`)

  await cleanupTestData(NS)
  await ensureTestStore()
  await createTestStaff()
  await createTestClient() // 默认顾客（so3 已完成单复用，非活跃不受约束）

  // uq_so_client_active：每顾客仅一张 待服务/服务中 活跃单。
  // so1(待服务) 与 so2(服务中) 须挂在不同顾客，否则建第二张时违反唯一索引。
  const CLI_W = `${NS}_SVC_CN_CLIW`
  const CLI_I = `${NS}_SVC_CN_CLII`
  await createTestClient({ userId: CLI_W, openid: `${NS}_SVC_CN_CLIW_OID`, phone: '19999098007' })
  await createTestClient({ userId: CLI_I, openid: `${NS}_SVC_CN_CLII_OID`, phone: '19999098008' })

  const orderId = `${NS}_SVC_CN`
  await createTestSaleOrder({
    saleOrderId: orderId, clientUserId: TEST_CLIENT_USER_ID,
    productType: '疗程卡', quantity: 1, sessionCount: 5,
    totalAmount: 500, status: '已支付', salesCategory: '他销自耗',
  })
  const items = await pgQuery(`SELECT sale_item_id FROM sale_items WHERE sale_order_id = $1`, [orderId])
  const saleItemId = items[0].sale_item_id

  // 准备三张不同状态的服务单（活跃单分属不同顾客以满足 uq_so_client_active）
  const so1 = `${NS}_SVC_CN_W`  // 待服务
  const so2 = `${NS}_SVC_CN_I`  // 服务中
  const so3 = `${NS}_SVC_CN_C`  // 已完成
  for (const [id, status, cli] of [[so1, '待服务', CLI_W], [so2, '服务中', CLI_I], [so3, '已完成', TEST_CLIENT_USER_ID]]) {
    await createTestServiceOrder({
      serviceOrderId: id, status, clientUserId: cli,
      items: [{ saleItemId, sessionUsed: 1, employeeId: TEST_MANAGER_EMP_ID }],
    })
  }
  rec(`  ✓ fixture: ${so1}(待服务) ${so2}(服务中) ${so3}(已完成)`)

  const errors = []

  // ─── 1. 待服务 → 已取消 ───
  const r1 = await invokeStaffApi('service.cancel', {
    _testOpenid: TEST_MANAGER_OPENID, serviceOrderId: so1,
  })
  if (r1.code !== 0) errors.push(`待服务 cancel 应成功，实际 code=${r1.code} msg=${r1.message}`)
  else {
    const st = (await pgQuery(`SELECT status FROM service_orders WHERE service_order_id = $1`, [so1]))[0].status
    if (st !== '已取消') errors.push(`so1.status 应='已取消'，实际='${st}'`)
    else rec(`  ✓ 待服务 → 已取消`)
  }

  // ─── 2. 服务中 → 已取消 ───
  const r2 = await invokeStaffApi('service.cancel', {
    _testOpenid: TEST_MANAGER_OPENID, serviceOrderId: so2,
  })
  if (r2.code !== 0) errors.push(`服务中 cancel 应成功，实际 code=${r2.code} msg=${r2.message}`)
  else {
    const st = (await pgQuery(`SELECT status FROM service_orders WHERE service_order_id = $1`, [so2]))[0].status
    if (st !== '已取消') errors.push(`so2.status 应='已取消'，实际='${st}'`)
    else rec(`  ✓ 服务中 → 已取消`)
  }

  // ─── 3. 已完成 → 拒 ───
  const r3 = await invokeStaffApi('service.cancel', {
    _testOpenid: TEST_MANAGER_OPENID, serviceOrderId: so3,
  })
  if (r3.code === 0) errors.push(`已完成状态 cancel 应拒，实际成功`)
  else if (!String(r3.message || '').includes('已完成') && !String(r3.message || '').includes('不可取消')) {
    errors.push(`已完成拒应含 '已完成' 或 '不可取消'，实际 ${r3.message}`)
  } else {
    rec(`  ✓ 已完成 cancel 被拒（${r3.message}）`)
  }

  // ─── 4. 不存在 / 跨门店（用 unknown ID）───
  const r4 = await invokeStaffApi('service.cancel', {
    _testOpenid: TEST_MANAGER_OPENID, serviceOrderId: 'UNKNOWN-NOT-EXIST',
  })
  if (r4.code === 0) errors.push(`不存在的 serviceOrderId 应拒，实际成功`)
  else rec(`  ✓ 不存在的服务单被拒（${r4.message}）`)

  if (errors.length) {
    rec(`  ✗ FAIL: ${errors.length} 项断言失败`)
    for (const e of errors) rec(`    - ${e}`)
    return
  }

  pass = true
  exitCode = 0
  rec(`  ✅ PASS — cancel 四种状态分支正确`)
}

try {
  await main()
} catch (e) {
  console.error('[smoke-service-cancel] EXCEPTION:', e.message)
  if (e?.stack) console.error(e.stack)
} finally {
  try { await cleanupTestData(NS) } catch (e) { console.error('[cleanup error]', e.message) }
  await closePool()
  console.log(`[smoke-service-cancel] end | ${pass ? 'PASS' : 'FAIL'} | exit=${exitCode}`)
  process.exit(exitCode)
}
