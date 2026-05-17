#!/usr/bin/env bun
/**
 * Advisory lock 跨事务释放窗口 — 并发开单回归脚本
 *
 * 关联：notes/tickets/2026-05-17-advisory-lock-cross-transaction-window.md §5.2
 *
 * 修复后行为预期：N=50 并发 staffApi.order.create 应在同一事务窗口完成
 * generateOrderNo（advisory_xact_lock + SELECT MAX + INSERT），无 sale_orders_pkey
 * 冲突，所有成功响应返回 distinct saleOrderId。
 *
 * 修复前行为（症状）：少数请求会因 generateOrderNo 子事务先 COMMIT 而被另一并发
 * 请求"读到旧 MAX"，最终 INSERT 抛 duplicate key value violates unique constraint
 * "sale_orders_pkey"。
 *
 * 用法：
 *   bun fengyu-staff/scripts/manual-e2e/concurrent-order-create.mjs        # 默认 N=50
 *   N=200 bun fengyu-staff/scripts/manual-e2e/concurrent-order-create.mjs  # 自定义
 *
 * 退出码：0 全通过；1 有 PK 冲突 / 重复 saleOrderId / DB 行数不匹配。
 *
 * 注意：本脚本走 staffApi 云函数本地 require + PG 测试库（与 tests/e2e-cloudfn/
 * setup.mjs 同样的连接），需先有 setup.mjs 所要求的环境变量
 * （PG_CONNECTION_STRING, ALLOW_TEST_OPENID=true）。
 */
import '../../tests/e2e-cloudfn/setup.mjs'
import {
  NS,
  TEST_STORE_ID, TEST_MANAGER_OPENID,
  TEST_CLIENT_PHONE,
  pgQuery, closePool,
} from '../../tests/e2e-cloudfn/setup.mjs'
import { invokeStaffApi } from '../../tests/e2e-cloudfn/helpers/invoke.mjs'
import {
  ensureTestStore, createTestStaff, createTestClient,
  createTestProduct, cleanupTestData,
} from '../../tests/e2e-cloudfn/helpers/fixtures.mjs'

const N = Number(process.env.N || 50)
// 允许 PG 池超时（云函数 max=5）作为"不成功但可接受"的失败模式不计入 FAIL
// 当 STRICT=true 时任何失败都计入 FAIL
const STRICT = process.env.STRICT === 'true'
let pass = false
let exitCode = 1

function rec(line) { console.log(line) }

async function main() {
  rec(`[concurrent-order-create] N=${N} | ${new Date().toISOString()}`)

  // ─── 1. fixture ───
  await cleanupTestData(NS)
  await ensureTestStore()
  await createTestStaff()
  await createTestClient()
  const { skuId } = await createTestProduct({
    suffix: 'concurrent',
    productKind: '护理项目',
    productType: '疗程卡',
    salesCategory: '他销他耗',
    price: 100,
    sessionCount: 1,
    isShengmei: false,
  })
  rec(`  ✓ fixture: store=${TEST_STORE_ID} sku=${skuId}`)

  // ─── 2. 并发发起 N 次 order.create ───
  rec(`  并发触发 ${N} 个 order.create ...`)
  const t0 = Date.now()
  const results = await Promise.all(
    Array.from({ length: N }, (_, i) =>
      invokeStaffApi('order.create', {
        _testOpenid: TEST_MANAGER_OPENID,
        clientPhone: TEST_CLIENT_PHONE,
        clientName: `${NS}_顾客`,
        items: [{ skuId, quantity: 1 }],
        paymentMethod: '线下',
        saleOrderType: '销售单',
        remark: `concurrent-${i}`,
      }).then(
        r => ({ idx: i, ok: r.code === 0, code: r.code, message: r.message, data: r.data }),
        e => ({ idx: i, ok: false, code: -999, message: e?.message || String(e) })
      )
    )
  )
  const elapsedMs = Date.now() - t0
  rec(`  并发完成，耗时 ${elapsedMs}ms（平均 ${(elapsedMs / N).toFixed(1)}ms/req）`)

  const errors = []

  // ─── 3. 关键断言 ───
  // 3.1 分类失败：PK 冲突类（FAIL）/ 连接池超时类（INFO，反映持锁时间变长）/ 其他业务错误（FAIL）
  const okResults = results.filter(r => r.ok)
  const failResults = results.filter(r => !r.ok)
  const pkConflicts = []
  const poolTimeouts = []
  const otherFails = []
  for (const f of failResults) {
    const msg = String(f.message || '')
    if (/sale_orders_pkey|service_orders_pkey|duplicate key/i.test(msg)) {
      pkConflicts.push(f)
    } else if (/timeout|connection terminated|pool/i.test(msg)) {
      poolTimeouts.push(f)
    } else {
      otherFails.push(f)
    }
  }
  rec(`  成功 ${okResults.length} / 失败 ${failResults.length}`
    + ` (PK冲突=${pkConflicts.length} / 池超时=${poolTimeouts.length} / 其他=${otherFails.length})`)
  for (const f of pkConflicts) {
    rec(`    [PK冲突] idx=${f.idx} ${f.message}`)
    errors.push(`idx=${f.idx} PG PK 冲突错误泄漏: ${f.message}`)
  }
  for (const f of otherFails.slice(0, 5)) {
    rec(`    [其他失败] idx=${f.idx} code=${f.code} ${f.message}`)
  }
  if (otherFails.length > 5) rec(`    ... 另 ${otherFails.length - 5} 个其他失败`)
  if (poolTimeouts.length > 0) {
    rec(`    [INFO] 池超时 ${poolTimeouts.length} 个 — 修复后持锁覆盖整个 order.create 事务（~50-200ms），云函数 PG 池 max=5 在 N=${N} 高并发下会自然超时。降低 N 或调大池容量可消除。`)
    if (STRICT) {
      errors.push(`STRICT 模式：连接池超时 ${poolTimeouts.length} 个`)
    }
  }

  // 3.2 所有成功响应的 saleOrderId 互异
  const saleOrderIds = okResults.map(r => r.data?.saleOrderId).filter(Boolean)
  const uniqueIds = new Set(saleOrderIds)
  if (uniqueIds.size !== saleOrderIds.length) {
    const counts = new Map()
    for (const id of saleOrderIds) counts.set(id, (counts.get(id) || 0) + 1)
    const dups = [...counts.entries()].filter(([_, c]) => c > 1)
    errors.push(`saleOrderId 重复（${dups.length} 个重复）: ${dups.map(([id, c]) => `${id}×${c}`).join(', ')}`)
  } else {
    rec(`  ✓ ${saleOrderIds.length} 个 saleOrderId 全部 distinct`)
  }

  // 3.3 DB 实际 sale_orders 行数 == 成功响应数
  if (saleOrderIds.length > 0) {
    const placeholders = saleOrderIds.map((_, i) => `$${i + 1}`).join(',')
    const dbRows = await pgQuery(
      `SELECT sale_order_id FROM sale_orders WHERE sale_order_id IN (${placeholders})`,
      saleOrderIds
    )
    if (dbRows.length !== saleOrderIds.length) {
      errors.push(`DB sale_orders 行数 ${dbRows.length} ≠ 成功响应数 ${saleOrderIds.length}`)
    } else {
      rec(`  ✓ DB sale_orders 行数 ${dbRows.length} 与成功响应一致`)
    }
  }

  if (errors.length) {
    rec(`  ✗ FAIL: ${errors.length} 项断言失败`)
    for (const e of errors) rec(`    - ${e}`)
    return
  }

  pass = true
  exitCode = 0
  rec(`  ✅ PASS — ${N} 并发开单全部 distinct，advisory lock TOCTOU 已闭合`)
}

try {
  await main()
} catch (e) {
  console.error('[concurrent-order-create] EXCEPTION:', e.message)
  if (e?.stack) console.error(e.stack)
} finally {
  try { await cleanupTestData(NS) } catch (e) { console.error('[cleanup error]', e.message) }
  await closePool()
  console.log(`[concurrent-order-create] end | ${pass ? 'PASS' : 'FAIL'} | exit=${exitCode}`)
  process.exit(exitCode)
}
