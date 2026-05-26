#!/usr/bin/env bun
/**
 * scope-s8：店长 A（store-nc01）尝试越权访问 store-nc02 数据应被拒绝
 *
 * 对标 admin `link-32-store-scope-list-isolation.spec.ts` 的"跨店反例"风格。
 * admin 链路验证页面层，本 spec 验证 staffApi 云函数直调层 — 两端 scope 语义必须一致。
 *
 * 覆盖 6 个核心断言（最小覆盖，每条对应一处刚加上的 scope 守卫）：
 *   1. staff.list({storeId: 'store-nc02'})         → PERMISSION_DENIED (isStoreInScope 拒)
 *   2. staff.bindStore({storeId: 'store-nc02'})    → PERMISSION_DENIED (isStoreInScope 拒)
 *   3. store.list()                                 → 仅返回 store-nc01，不含 store-nc02
 *   4. customer.paidOrders({clientUserId=NC02})    → PERMISSION_DENIED (assertCustomerInScope)
 *   5. customer.customerBalance({customerUserId=NC02}) → PERMISSION_DENIED (assertCustomerInScope)
 *   6. order.qrcode({saleOrderId=NC02 临时单})     → PERMISSION_DENIED (isStoreInScope)
 *
 * 关键引用：
 *   - routes/staff.js:64-78 (list)、121-134 (departments，同 list)、471-485 (bindStore)
 *   - routes/store.js:17-53 (list scope 过滤)
 *   - routes/customer.js:444-455 (paidOrders)、980-989 (customerBalance)
 *   - routes/order.js:779-807 (qrcode 含 isStoreInScope)
 *
 * 临时数据：第 6 条断言需要 store-nc02 上一笔 sale_order，admin seed 不提供 — 本 spec 在
 * 入口 seed `FY-SCOPES8-WX-0001`（sale_order + sale_item），afterAll cleanup。
 * 与 admin link-32 的 `FY-CHAIN32-WX-0001` 临时单同模式（自管理 → 不污染 fixtures）。
 */
import './setup.mjs'
import { SCOPE_OPENID, SCOPE_CLIENTS, SCOPE_TOPOLOGY, ensureOpenidsSeeded } from './setup.mjs'
import { invokeStaffApi } from '../e2e-cloudfn/helpers/invoke.mjs'
import { pgQuery, closePool } from '../e2e-cloudfn/setup.mjs'

const TAG = 'SCOPES8'
const TEMP_SOID = `FY-${TAG}-WX-0001`
const TEMP_SIID = `FY-${TAG}-WX-0001-01`

let pass = false
let exitCode = 1
function rec(line) { console.log(line) }

function isDenied(r) {
  if (r.code === 0) return false
  if (r.code === -403) return true
  return /PERMISSION_DENIED/.test(r.message || '')
}

async function seedTempNc02Order() {
  // 创建一笔 store-nc02 临时订单 + sale_item，供 order.qrcode 断言用
  // 与 admin link-32 seedStoreNc02Data 同 SQL 模板，字段裁剪到最小
  await pgQuery(`
    INSERT INTO sale_orders (
      sale_order_id, status, sale_order_type, market_name, store_id,
      sale_order_datetime, client_user_id, client_phone, customer_name,
      total_amount, payment_method, opened_by, created_at, updated_at,
      payable_amount, received, refunded_amount, prepaid_card_amount
    ) VALUES (
      $1, '已支付', '销售单', '南昌市场', $2,
      NOW(), $3, '13800138002', 'NC02测试客',
      100.00, '线下', 'FY-TEST-MGR2', NOW(), NOW(),
      100.00, 100.00, 0, 0
    )
    ON CONFLICT (sale_order_id) DO NOTHING
  `, [TEMP_SOID, SCOPE_TOPOLOGY.STORE_NC02, SCOPE_CLIENTS.NC02])
  await pgQuery(`
    INSERT INTO sale_items (
      sale_item_id, sale_order_id, store_id, item_direction, sku_id,
      product_name, sku_spec_name, product_type, session_count, remaining_sessions,
      unit_price, quantity, unit_real_price, sale_amount, received,
      service_fee, is_experience, created_at, updated_at
    ) VALUES (
      $1, $2, $3, '购买', 'c79157b29c9e974c',
      '洗-无创纹身', '洗-无创纹身 疗程卡', '疗程卡', 1, 1,
      100.00, 1, 100.00, 100.00, 100.00,
      0, false, NOW(), NOW()
    )
    ON CONFLICT (sale_item_id) DO NOTHING
  `, [TEMP_SIID, TEMP_SOID, SCOPE_TOPOLOGY.STORE_NC02])
}

async function cleanupTempNc02Order() {
  // 严格只删本 TAG 的行，与已有 fixtures 完全隔离
  await pgQuery(`DELETE FROM sale_items WHERE sale_order_id = $1`, [TEMP_SOID])
  await pgQuery(`DELETE FROM sale_orders WHERE sale_order_id = $1`, [TEMP_SOID])
}

async function main() {
  rec('[scope-s8] start')
  ensureOpenidsSeeded()

  // 前置 sanity：fixture 顾客和员工存在
  const sanityClient = await pgQuery(
    `SELECT user_id, bound_store_id FROM client_wechat_users WHERE user_id=$1`,
    [SCOPE_CLIENTS.NC02],
  )
  if (sanityClient.length === 0 || sanityClient[0].bound_store_id !== SCOPE_TOPOLOGY.STORE_NC02) {
    rec(`  ✗ FAIL: NC02 顾客 ${SCOPE_CLIENTS.NC02} 不存在或未绑定 store-nc02 — 请先跑 admin seed-scope-fixtures.sql`)
    return
  }
  const sanityMgr = await pgQuery(
    `SELECT employee_id, store_id FROM staff_wechat_users WHERE employee_id='FY-TEST-MGR'`,
  )
  if (sanityMgr.length === 0 || sanityMgr[0].store_id !== SCOPE_TOPOLOGY.STORE_NC01) {
    rec(`  ✗ FAIL: FY-TEST-MGR 不存在或未绑定 store-nc01`)
    return
  }
  rec(`  ✓ fixture 就绪：MGR@store-nc01, NC02 顾客@store-nc02`)

  // seed 临时 NC02 订单
  await cleanupTempNc02Order() // 先清一遍残留
  await seedTempNc02Order()
  rec(`  ✓ seed 临时订单 ${TEMP_SOID}@store-nc02`)

  const errors = []
  const baseCtx = {
    _testOpenid: SCOPE_OPENID.MGR,
    _loginLevel: 'store',
    _currentStoreId: SCOPE_TOPOLOGY.STORE_NC01,
  }

  try {
    // ── 1. staff.list 跨店枚举 ──
    {
      const r = await invokeStaffApi('staff.list', {
        ...baseCtx,
        storeId: SCOPE_TOPOLOGY.STORE_NC02,
      })
      if (!isDenied(r)) {
        errors.push(`(1) staff.list 跨店应被拒, 实际 code=${r.code} msg=${r.message}`)
      } else {
        rec(`  ✓ (1) staff.list({storeId:'store-nc02'}) → 拒 (${r.code} ${r.message})`)
      }
    }

    // ── 2. staff.bindStore 跨店切换 ──
    {
      // 注意：bindStore 成功会持久化 staff_wechat_users.store_id，必须确保拒后无副作用
      const beforeRows = await pgQuery(
        `SELECT store_id FROM staff_wechat_users WHERE employee_id='FY-TEST-MGR'`,
      )
      const beforeStore = beforeRows[0]?.store_id

      const r = await invokeStaffApi('staff.bindStore', {
        ...baseCtx,
        storeId: SCOPE_TOPOLOGY.STORE_NC02,
      })
      if (!isDenied(r)) {
        errors.push(`(2) staff.bindStore 跨店应被拒, 实际 code=${r.code} msg=${r.message}`)
      } else {
        rec(`  ✓ (2) staff.bindStore({storeId:'store-nc02'}) → 拒 (${r.code} ${r.message})`)
      }

      // 防御：DB 上 MGR.store_id 必须保持原值
      const afterRows = await pgQuery(
        `SELECT store_id FROM staff_wechat_users WHERE employee_id='FY-TEST-MGR'`,
      )
      if (afterRows[0]?.store_id !== beforeStore) {
        errors.push(`(2) MGR.store_id 被改写: ${beforeStore} → ${afterRows[0]?.store_id}（应保持不变）`)
      }
    }

    // ── 3. store.list scope 锁定 ──
    {
      const r = await invokeStaffApi('store.list', baseCtx)
      if (r.code !== 0) {
        errors.push(`(3) store.list code=${r.code} msg=${r.message}`)
      } else {
        const ids = (r.data || []).map((s) => s.storeId)
        const hasNc01 = ids.includes(SCOPE_TOPOLOGY.STORE_NC01)
        const hasNc02 = ids.includes(SCOPE_TOPOLOGY.STORE_NC02)
        if (!hasNc01) errors.push(`(3) store.list 应含 store-nc01, 实际 ids=${JSON.stringify(ids)}`)
        if (hasNc02) errors.push(`(3) store.list 不应含 store-nc02, 实际 ids=${JSON.stringify(ids)}`)
        if (hasNc01 && !hasNc02) {
          rec(`  ✓ (3) store.list 仅返回 [${ids.join(',')}]，不含 store-nc02`)
        }
      }
    }

    // ── 4. customer.paidOrders 越权 ──
    {
      const r = await invokeStaffApi('customer.paidOrders', {
        ...baseCtx,
        clientUserId: SCOPE_CLIENTS.NC02,
      })
      if (!isDenied(r)) {
        errors.push(`(4) customer.paidOrders NC02 应被拒, 实际 code=${r.code} msg=${r.message}`)
      } else {
        rec(`  ✓ (4) customer.paidOrders({clientUserId=NC02}) → 拒 (${r.code} ${r.message})`)
      }
    }

    // ── 5. customer.customerBalance 越权 ──
    {
      const r = await invokeStaffApi('customer.customerBalance', {
        ...baseCtx,
        customerUserId: SCOPE_CLIENTS.NC02,
      })
      if (!isDenied(r)) {
        errors.push(`(5) customer.customerBalance NC02 应被拒, 实际 code=${r.code} msg=${r.message}`)
      } else {
        rec(`  ✓ (5) customer.customerBalance({customerUserId=NC02}) → 拒 (${r.code} ${r.message})`)
      }
    }

    // ── 6. order.qrcode 越权 ──
    {
      const r = await invokeStaffApi('order.qrcode', {
        ...baseCtx,
        saleOrderId: TEMP_SOID,
      })
      if (!isDenied(r)) {
        errors.push(`(6) order.qrcode NC02 订单应被拒, 实际 code=${r.code} msg=${r.message}`)
      } else {
        rec(`  ✓ (6) order.qrcode({saleOrderId=${TEMP_SOID}}) → 拒 (${r.code} ${r.message})`)
      }
    }
  } finally {
    // 无论是否失败都清理临时数据
    try { await cleanupTempNc02Order() } catch (e) {
      rec(`  ⚠ cleanup 异常: ${e.message}`)
    }
  }

  if (errors.length) {
    rec(`  ✗ FAIL: ${errors.length} 项`)
    for (const e of errors) rec(`    - ${e}`)
    return
  }
  pass = true
  exitCode = 0
  rec(`  ✅ PASS — 店长 A 跨店访问 store-nc02 数据全部被拒（6/6）`)
}

try {
  await main()
} catch (e) {
  console.error('EXCEPTION:', e.message)
  console.error(e.stack)
} finally {
  try { await closePool() } catch {}
  process.exit(pass ? 0 : exitCode)
}
