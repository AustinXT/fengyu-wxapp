#!/usr/bin/env bun
/**
 * scope-s1 + s2：customer.search / paidOrders / calendar 跨店不可见
 *
 * 业务约束：
 *   - customer.search(keyword) 按 effectiveStoreId 过滤（仅本店顾客命中）
 *   - customer.search(phone)   设计上跨店命中（顾客换店仍可识别），但仅返回身份信息，不
 *     提供历史；保留是合理的，不视为越权
 *   - customer.paidOrders / calendar 在 SQL 层加 buildStoreScopeCondition(o.store_id) 过滤，
 *     MGR(nc01) 查 NC02 顾客时返回 0 行（即使顾客 user_id 可猜）
 *
 * 验证矩阵：
 *   1. MGR(nc01) keyword='NC02测试客' → 0 命中
 *   2. MGR(nc01) phone='13800138002' (NC02 顾客) → 命中（设计 cross-store 身份匹配）
 *   3. MGR(nc01) phone= (空) → list 含 nc01 顾客，不含 NC02 / OM 顾客
 *   4. MGR2(nc02) keyword='NC01' → 0 命中
 *   5. MGR(nc01) 用 NC02 顾客 user_id 查 paidOrders → 0 行
 *   6. MGR(nc01) 用 NC02 顾客 user_id 查 calendar → 0 行（不返回非本店订单）
 */
import './setup.mjs'
import { SCOPE_OPENID, SCOPE_CLIENTS, SCOPE_TOPOLOGY, ensureOpenidsSeeded } from './setup.mjs'
import { invokeStaffApi } from '../e2e-cloudfn/helpers/invoke.mjs'
import { pgQuery, closePool } from '../e2e-cloudfn/setup.mjs'

let pass = false
let exitCode = 1
function rec(line) { console.log(line) }

async function main() {
  rec('[scope-s1] start')
  ensureOpenidsSeeded()

  // 前置 sanity：NC02 顾客存在且绑定 store-nc02
  const sanity = await pgQuery(
    `SELECT user_id, name, phone, bound_store_id FROM client_wechat_users WHERE user_id=$1`,
    [SCOPE_CLIENTS.NC02],
  )
  if (sanity.length === 0 || sanity[0].bound_store_id !== SCOPE_TOPOLOGY.STORE_NC02) {
    rec(`  ✗ FAIL: NC02 顾客 ${SCOPE_CLIENTS.NC02} 不存在或未绑定 store-nc02 — 请先跑 admin seed-scope-fixtures.sql`)
    return
  }
  rec(`  ✓ NC02 顾客 fixture 就绪：phone=${sanity[0].phone}`)

  const errors = []

  // ── 1. MGR(nc01) keyword='NC02测试客' → 0 命中 ──
  {
    const r = await invokeStaffApi('customer.search', {
      _testOpenid: SCOPE_OPENID.MGR,
      _loginLevel: 'store',
      _currentStoreId: SCOPE_TOPOLOGY.STORE_NC01,
      keyword: 'NC02测试客',
    })
    if (r.code !== 0) {
      errors.push(`(1) MGR keyword search code=${r.code} msg=${r.message}`)
    } else {
      const hit = r.data.find((c) => c.name === 'NC02测试客')
      if (hit) errors.push(`(1) MGR keyword 不应命中 NC02 顾客, 实际=${JSON.stringify(hit)}`)
      else rec(`  ✓ (1) MGR(nc01) keyword='NC02测试客' → 0 命中 (returned=${r.data.length})`)
    }
  }

  // ── 2. MGR(nc01) phone='13800138002' (NC02 顾客手机号) → 命中（设计 cross-store） ──
  {
    const r = await invokeStaffApi('customer.search', {
      _testOpenid: SCOPE_OPENID.MGR,
      _loginLevel: 'store',
      _currentStoreId: SCOPE_TOPOLOGY.STORE_NC01,
      phone: '13800138002',
    })
    if (r.code !== 0) {
      errors.push(`(2) MGR phone search code=${r.code} msg=${r.message}`)
    } else {
      const hit = r.data.find((c) => c.clientUserId === SCOPE_CLIENTS.NC02)
      if (!hit) errors.push(`(2) MGR phone 应命中 NC02 顾客身份（cross-store 设计），实际=0 命中`)
      else rec(`  ✓ (2) MGR(nc01) phone 命中 NC02 顾客身份 (设计 cross-store match)`)
    }
  }

  // ── 3. MGR(nc01) empty search → 列表中无 NC02 / OM 顾客 ──
  {
    const r = await invokeStaffApi('customer.search', {
      _testOpenid: SCOPE_OPENID.MGR,
      _loginLevel: 'store',
      _currentStoreId: SCOPE_TOPOLOGY.STORE_NC01,
    })
    if (r.code !== 0) {
      errors.push(`(3) MGR empty search code=${r.code} msg=${r.message}`)
    } else {
      const hasNc02 = r.data.some((c) => c.clientUserId === SCOPE_CLIENTS.NC02)
      const hasOm = r.data.some((c) => c.clientUserId === SCOPE_CLIENTS.OTHER_MARKET)
      if (hasNc02) errors.push(`(3) MGR empty list 不应含 NC02`)
      if (hasOm) errors.push(`(3) MGR empty list 不应含 OM 顾客`)
      if (!hasNc02 && !hasOm) rec(`  ✓ (3) MGR(nc01) empty list (n=${r.data.length}) 不含跨店顾客`)
    }
  }

  // ── 4. MGR2(nc02) keyword='NC01' → 0 命中 ──
  {
    const r = await invokeStaffApi('customer.search', {
      _testOpenid: SCOPE_OPENID.MGR2,
      _loginLevel: 'store',
      _currentStoreId: SCOPE_TOPOLOGY.STORE_NC02,
      keyword: 'NC01测试客',
    })
    if (r.code !== 0) {
      // 若 MGR2 fixture 未生效（如缺 store_id / scope_id），允许 SKIP 而非 hard fail
      if (r.code === -401 || r.code === -403) {
        rec(`  ⚠ (4) MGR2 fixture 可能未 seed (code=${r.code}); SKIP`)
      } else {
        errors.push(`(4) MGR2 keyword search code=${r.code} msg=${r.message}`)
      }
    } else {
      const hit = r.data.find((c) => c.name?.startsWith('NC01'))
      if (hit) errors.push(`(4) MGR2 不应命中 NC01 顾客, 实际=${JSON.stringify(hit)}`)
      else rec(`  ✓ (4) MGR2(nc02) keyword='NC01测试客' → 0 命中`)
    }
  }

  // ── 5. MGR(nc01) paidOrders 查 NC02 顾客 → 0 行（scope 过滤） ──
  {
    const r = await invokeStaffApi('customer.paidOrders', {
      _testOpenid: SCOPE_OPENID.MGR,
      _loginLevel: 'store',
      _currentStoreId: SCOPE_TOPOLOGY.STORE_NC01,
      clientUserId: SCOPE_CLIENTS.NC02,
    })
    if (r.code !== 0) {
      // paidOrders 对跨 scope 顾客可能直接 PERMISSION_DENIED（更严格的 assertCustomerInScope）
      const isDenied = r.code === -403 || /PERMISSION_DENIED|NOT_FOUND/.test(r.message || '')
      if (isDenied) {
        rec(`  ✓ (5) MGR(nc01) paidOrders for NC02 → 被拒 (code=${r.code} ${r.message})`)
      } else {
        errors.push(`(5) MGR paidOrders for NC02 code=${r.code} msg=${r.message}`)
      }
    } else {
      const count = (r.data?.orders || []).length
      if (count > 0) errors.push(`(5) MGR paidOrders for NC02 应为 0 行, 实际=${count}`)
      else rec(`  ✓ (5) MGR(nc01) paidOrders for NC02 → 0 行`)
    }
  }

  // ── 6. MGR(nc01) calendar 查 NC02 顾客 → 0 行或被拒 ──
  {
    const today = new Date()
    const yearStart = `${today.getFullYear()}-01-01`
    const yearEnd = `${today.getFullYear() + 1}-01-01`
    const r = await invokeStaffApi('customer.calendar', {
      _testOpenid: SCOPE_OPENID.MGR,
      _loginLevel: 'store',
      _currentStoreId: SCOPE_TOPOLOGY.STORE_NC01,
      clientUserId: SCOPE_CLIENTS.NC02,
      startDate: yearStart,
      endDate: yearEnd,
    })
    if (r.code !== 0) {
      const isDenied = r.code === -403 || /PERMISSION_DENIED|NOT_FOUND/.test(r.message || '')
      if (isDenied) {
        rec(`  ✓ (6) MGR(nc01) calendar for NC02 → 被拒 (code=${r.code} ${r.message})`)
      } else {
        errors.push(`(6) MGR calendar for NC02 code=${r.code} msg=${r.message}`)
      }
    } else {
      // calendar 返回 { calendar, orders }；orders 应空
      const count = (r.data?.orders || []).length
      if (count > 0) errors.push(`(6) MGR calendar for NC02 orders 应为 0, 实际=${count}`)
      else rec(`  ✓ (6) MGR(nc01) calendar for NC02 → 0 orders`)
    }
  }

  if (errors.length) {
    rec(`  ✗ FAIL: ${errors.length} 项`)
    for (const e of errors) rec(`    - ${e}`)
    return
  }
  pass = true
  exitCode = 0
  rec(`  ✅ PASS — customer.search / paidOrders / calendar scope 隔离生效`)
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
