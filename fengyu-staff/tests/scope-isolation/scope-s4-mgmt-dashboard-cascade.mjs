#!/usr/bin/env bun
/**
 * scope-s4 + s5：mgmtDashboard.scopeOptions 级联返回 + summary validateScope 校验
 *
 * 验证两组行为：
 *
 *   S-4 scopeOptions（市场列表 / 总部全量）
 *     - ADM(headquarters) → markets = 全部活跃市场
 *     - MKT(南昌市场)      → markets = [南昌市场]（仅自己 scope）
 *
 *   S-5 summary.validateScope（拦截越权请求）
 *     - MKT(南昌) 传 scopeType='all'                  → PERMISSION_DENIED
 *     - MKT(南昌) 传 scopeType='market', scopeId=NC2  → PERMISSION_DENIED
 *     - MKT(南昌) 传 scopeType='store', scopeId=他市场门店 → PERMISSION_DENIED
 *     - ADM(总部) 传 scopeType='all'                  → 通过
 *     - MGR(店长) 调 summary → requireManagementLevel 拦截 (staff_level=store)
 *
 * 关键引用：
 *   - routes/mgmt-dashboard.js:scopeOptions (98-119)
 *   - routes/mgmt-dashboard.js:validateScope (130-154)
 *   - routes/mgmt-dashboard.js:summary       (525+)
 */
import './setup.mjs'
import { SCOPE_OPENID, SCOPE_TOPOLOGY, ensureOpenidsSeeded } from './setup.mjs'
import { invokeStaffApi } from '../e2e-cloudfn/helpers/invoke.mjs'
import { pgQuery, closePool } from '../e2e-cloudfn/setup.mjs'

let pass = false
let exitCode = 1
function rec(line) { console.log(line) }

async function main() {
  rec('[scope-s4] start')
  ensureOpenidsSeeded()

  const errors = []
  const today = new Date().toISOString().slice(0, 10)

  // ── S-4.1: ADM scopeOptions → 全部市场 ──
  {
    const r = await invokeStaffApi('mgmtDashboard.scopeOptions', {
      _testOpenid: SCOPE_OPENID.ADM,
      _loginLevel: 'management',
    })
    if (r.code !== 0) {
      errors.push(`(S4.1) ADM scopeOptions code=${r.code} msg=${r.message}`)
    } else {
      const markets = r.data?.markets || []
      const dbMarketCount = parseInt((await pgQuery(
        `SELECT COUNT(*)::text AS c FROM org_nodes WHERE type='市场' AND is_active=true`,
      ))[0]?.c || '0', 10)
      if (Math.abs(markets.length - dbMarketCount) > 1) {
        errors.push(`(S4.1) ADM markets=${markets.length}, db=${dbMarketCount} 不一致`)
      } else {
        rec(`  ✓ (S4.1) ADM scopeOptions markets=${markets.length} (db=${dbMarketCount}) staffLevel=${r.data.staffLevel}`)
      }
    }
  }

  // ── S-4.2: MKT scopeOptions → 仅南昌市场 ──
  {
    const r = await invokeStaffApi('mgmtDashboard.scopeOptions', {
      _testOpenid: SCOPE_OPENID.MKT,
      _loginLevel: 'management',
    })
    if (r.code !== 0) {
      errors.push(`(S4.2) MKT scopeOptions code=${r.code} msg=${r.message}`)
    } else {
      const markets = r.data?.markets || []
      const onlyNc = markets.length === 1 && markets[0].id === SCOPE_TOPOLOGY.MARKET_NC
      if (!onlyNc) {
        errors.push(`(S4.2) MKT markets 应仅=南昌市场, 实际=${JSON.stringify(markets.map(m => m.id))}`)
      } else {
        rec(`  ✓ (S4.2) MKT scopeOptions = [南昌市场] (id=${markets[0].id})`)
      }
    }
  }

  // ── S-5.1: MKT summary scopeType='all' → 拒 ──
  {
    const r = await invokeStaffApi('mgmtDashboard.summary', {
      _testOpenid: SCOPE_OPENID.MKT,
      _loginLevel: 'management',
      date: today,
      scopeType: 'all',
    })
    const isDenied = r.code !== 0 && /PERMISSION_DENIED/.test(r.message || '')
    if (!isDenied) {
      errors.push(`(S5.1) MKT summary scopeType=all 应拒, 实际 code=${r.code} msg=${r.message}`)
    } else {
      rec(`  ✓ (S5.1) MKT summary scopeType='all' → 拒 (${r.message})`)
    }
  }

  // ── S-5.2: MKT summary scopeType='market', scopeId=南昌市场2 → 拒 ──
  {
    const r = await invokeStaffApi('mgmtDashboard.summary', {
      _testOpenid: SCOPE_OPENID.MKT,
      _loginLevel: 'management',
      date: today,
      scopeType: 'market',
      scopeId: SCOPE_TOPOLOGY.MARKET_NC2,
    })
    const isDenied = r.code !== 0 && /PERMISSION_DENIED/.test(r.message || '')
    if (!isDenied) {
      errors.push(`(S5.2) MKT summary market=NC2 应拒, 实际 code=${r.code} msg=${r.message}`)
    } else {
      rec(`  ✓ (S5.2) MKT summary market=NC2 → 拒 (${r.message})`)
    }
  }

  // ── S-5.3: MKT summary scopeType='store', scopeId=他市场门店 → 拒 ──
  {
    const r = await invokeStaffApi('mgmtDashboard.summary', {
      _testOpenid: SCOPE_OPENID.MKT,
      _loginLevel: 'management',
      date: today,
      scopeType: 'store',
      scopeId: SCOPE_TOPOLOGY.STORE_OTHER_MARKET,
    })
    const isDenied = r.code !== 0 && /PERMISSION_DENIED/.test(r.message || '')
    if (!isDenied) {
      errors.push(`(S5.3) MKT summary store=他市场门店 应拒, 实际 code=${r.code} msg=${r.message}`)
    } else {
      rec(`  ✓ (S5.3) MKT summary store=他市场门店 → 拒 (${r.message})`)
    }
  }

  // ── S-5.4: ADM summary scopeType='all' → 通过（正例对照） ──
  {
    const r = await invokeStaffApi('mgmtDashboard.summary', {
      _testOpenid: SCOPE_OPENID.ADM,
      _loginLevel: 'management',
      date: today,
      scopeType: 'all',
    })
    if (r.code !== 0) {
      errors.push(`(S5.4) ADM summary all 应通过, 实际 code=${r.code} msg=${r.message}`)
    } else {
      rec(`  ✓ (S5.4) ADM summary scopeType='all' → 通过`)
    }
  }

  // ── S-5.5: MGR summary → requireManagementLevel 拦截 ──
  {
    const r = await invokeStaffApi('mgmtDashboard.summary', {
      _testOpenid: SCOPE_OPENID.MGR,
      _loginLevel: 'store',
      _currentStoreId: SCOPE_TOPOLOGY.STORE_NC01,
      date: today,
      scopeType: 'store',
      scopeId: SCOPE_TOPOLOGY.STORE_NC01,
    })
    const isDenied = r.code !== 0 && /PERMISSION_DENIED|UNAUTHORIZED/.test(r.message || '')
    if (!isDenied) {
      errors.push(`(S5.5) MGR summary 应被 requireManagementLevel 拦截, 实际 code=${r.code} msg=${r.message}`)
    } else {
      rec(`  ✓ (S5.5) MGR summary → 拒 (${r.message})`)
    }
  }

  if (errors.length) {
    rec(`  ✗ FAIL: ${errors.length} 项`)
    for (const e of errors) rec(`    - ${e}`)
    return
  }
  pass = true
  exitCode = 0
  rec(`  ✅ PASS — scopeOptions 级联 + summary validateScope 五路反例全拦截`)
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
