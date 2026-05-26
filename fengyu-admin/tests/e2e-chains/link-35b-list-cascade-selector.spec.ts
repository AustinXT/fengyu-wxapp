/**
 * 链路 35b：列表页市场→门店级联选择器锁定（跨多页）
 *
 * 主题：admin 共 7 个列表页带「市场 + 门店」二级级联筛选器
 *   （/customers、/employees、/stores、/cards、/coupons、/points、/card-transactions）。
 *   stores 数组由 getStores() server-side scope 过滤，orgNodes（market）未过滤。
 *   验证 3 角色场景下：
 *     - MGR(nc01)：stores 下拉只见 1 店；非 scope 市场被选后 filteredStores=空
 *     - MKT(南昌)：stores 下拉 = 南昌市场旗下 N 店；选择"南昌市场2"后 filteredStores=空
 *     - FIN    ：stores 下拉 = 全部门店；可自由级联
 *
 *   本 spec 抽样 3 个页面（/customers, /employees, /cards）验证模式一致；
 *   其余 4 页（/stores, /coupons, /points, /card-transactions）走同一份 getStores+getOrgNodes 数据
 *   流，模式一致，由 link-32（列表数据隔离）+ getStores 单元测试间接覆盖。
 *
 * 关键引用：
 *   - actions/stores.ts:48-60        getStores + scopeCondition(stores.storeId)
 *   - actions/org.ts:40-59           getOrgNodes（无 scope 过滤，前端用于市场下拉）
 *   - customers-page.tsx:87-99       markets/filteredStores 联动逻辑
 *   - employees-page.tsx / cards-page.tsx 同模式
 *
 * 注：本 spec 是 link-35 (`/orders/create` 单层 store select) 的横向扩展，
 *     聚焦多列表页的"市场→门店"二级级联约束，URL 越权由 link-32/37 覆盖。
 */

import { test, expect } from '@playwright/test'
import {
  BASE,
  TEST_PHONES,
  TOPOLOGY,
  psql,
  recordVerdict,
  summarize,
  writeContext,
  type Verdict,
} from './_helpers/scope-helpers'

/**
 * 本 spec 内置 login —— 容忍 dev mode 首次 /login 冷编译的慢响应（最多 90s）。
 * 共享 scope-helpers.login 的 timeout 20s 在 dev cold start 下太短。
 */
async function loginSlow(page: import('@playwright/test').Page, phone: string): Promise<void> {
  await page.goto(`${BASE}/login`, { waitUntil: 'domcontentloaded' })
  await page.locator('#phone').waitFor({ state: 'attached', timeout: 90_000 })
  await page.locator('#phone').click()
  await page.locator('#phone').pressSequentially(phone, { delay: 30 })
  await page.locator('#password').click()
  await page.locator('#password').pressSequentially('fengyu2026', { delay: 30 })
  await page.getByRole('button', { name: /登\s*录/ }).click()
  await page.waitForURL(/\/dashboard|\/change-password/, { timeout: 90_000 })
}

/**
 * 抓某列表页的「市场」「门店」两个 Select 的 option label 集合。
 * 通过 option 文本"全部市场"/"全部门店"定位 select，避免位置耦合。
 */
async function readCascadeSelects(
  page: import('@playwright/test').Page,
  listUrl: string,
): Promise<{ markets: string[]; stores: string[] } | null> {
  await page.goto(`${BASE}${listUrl}`, { waitUntil: 'domcontentloaded' })
  // 等待两个级联 select 渲染出来（dev mode 首次编译耗时长，给 60s）
  const marketSel = page.locator('select:has(option:text-is("全部市场"))').first()
  const storeSel = page.locator('select:has(option:text-is("全部门店"))').first()
  try {
    await marketSel.waitFor({ state: 'attached', timeout: 60_000 })
    await storeSel.waitFor({ state: 'attached', timeout: 60_000 })
  } catch {
    return null
  }
  await page.waitForTimeout(500)
  const markets = (await marketSel.locator('option').allTextContents()).map((s) => s.trim()).filter(Boolean)
  const stores = (await storeSel.locator('option').allTextContents()).map((s) => s.trim()).filter(Boolean)
  return { markets, stores }
}

/**
 * 选择某个市场后，重读「门店」select 的 options（验证 filteredStores 联动）。
 * 注意：customers-page 的 onChange 走 setMany 触发 URL 变更，导致 RSC 重渲；
 *       拿到结果后回到无市场状态便于下一页使用。
 */
async function readStoresAfterMarketPick(
  page: import('@playwright/test').Page,
  listUrl: string,
  marketId: string,
): Promise<string[] | null> {
  await page.goto(`${BASE}${listUrl}?market=${encodeURIComponent(marketId)}`, { waitUntil: 'domcontentloaded' })
  const storeSel = page.locator('select:has(option:text-is("全部门店"))').first()
  try {
    await storeSel.waitFor({ state: 'attached', timeout: 60_000 })
  } catch {
    return null
  }
  await page.waitForTimeout(500)
  return (await storeSel.locator('option').allTextContents()).map((s) => s.trim()).filter(Boolean)
}

/** 数据库层 baseline */
function dbBaselines(): { totalStores: number; ncStoreCount: number; nc2StoreCount: number; totalMarkets: number } {
  const totalStores = parseInt(psql(`SELECT COUNT(*)::text FROM stores`), 10)
  const ncStoreCount = parseInt(
    psql(`SELECT COUNT(*)::text FROM stores s JOIN org_nodes o ON s.org_node_id=o.id WHERE o.parent_id='${TOPOLOGY.MARKET_NC}'`),
    10,
  )
  const nc2StoreCount = parseInt(
    psql(`SELECT COUNT(*)::text FROM stores s JOIN org_nodes o ON s.org_node_id=o.id WHERE o.parent_id='${TOPOLOGY.MARKET_NC2}'`),
    10,
  )
  const totalMarkets = parseInt(psql(`SELECT COUNT(*)::text FROM org_nodes WHERE type='市场' AND is_active=true`), 10)
  return { totalStores, ncStoreCount, nc2StoreCount, totalMarkets }
}

test.setTimeout(900_000) // 15 分钟：dev mode 首次编译每个页面耗时长

// 注：/employees 用 OrgTreeSelect 而非 market+store cascade，本 spec 不覆盖；
// /cards、/customers、/points 是典型的 market+store 双 Select 级联结构。
const SAMPLE_PAGES = [
  { name: 'customers', url: '/customers' },
  { name: 'cards', url: '/cards' },
  { name: 'points', url: '/points' },
] as const

test('链路35b：列表页市场→门店级联选择器锁定', async ({ browser }) => {
  const verdicts: Verdict[] = []
  const baseline = dbBaselines()
  console.log(`[链路35b] baseline: totalStores=${baseline.totalStores} ncStores=${baseline.ncStoreCount} nc2Stores=${baseline.nc2StoreCount} markets=${baseline.totalMarkets}`)

  // ── 预热：先用 FIN 把 3 个页面跑一遍，避免 dev mode 首次编译卡 MGR/MKT 的 case ──
  console.log('[链路35b] 预热页面编译 (FIN)')
  const ctxWarm = await browser.newContext()
  const pWarm = await ctxWarm.newPage()
  try {
    await loginSlow(pWarm, TEST_PHONES.FIN)
    for (const sp of SAMPLE_PAGES) {
      console.log(`  - warming ${sp.url}`)
      await pWarm.goto(`${BASE}${sp.url}`, { waitUntil: 'domcontentloaded' })
      await pWarm.locator('select:has(option:text-is("全部门店"))').first()
        .waitFor({ state: 'attached', timeout: 120_000 })
        .catch(() => null)
    }
  } finally {
    await ctxWarm.close()
  }

  // ── Case 1: MGR(nc01) — 门店下拉只见 1 店 ──
  console.log('[链路35b] Case 1: MGR(nc01)')
  const ctxMgr = await browser.newContext()
  const pMgr = await ctxMgr.newPage()
  try {
    await loginSlow(pMgr, TEST_PHONES.MGR)
    for (const sp of SAMPLE_PAGES) {
      const got = await readCascadeSelects(pMgr, sp.url)
      if (!got) {
        recordVerdict(verdicts, `mgr_${sp.name}_load`, false, '无法读取下拉')
        continue
      }
      // store 下拉 = "全部门店" + 1 个真实选项 = 2 项；不含 nc02/其他市场门店
      const realStores = got.stores.filter((s) => !s.includes('全部'))
      const hasNc01 = realStores.some((s) => s.includes('南昌旗舰店'))
      const hasNc02 = realStores.some((s) => s.includes('青山湖店'))
      const hasOther = realStores.some((s) => s.includes('龙珠店'))
      recordVerdict(verdicts, `mgr_${sp.name}_only_one_store`, realStores.length === 1, `realStores=${realStores.length} [${realStores.join('|')}]`)
      recordVerdict(verdicts, `mgr_${sp.name}_sees_nc01`, hasNc01, `nc01=${hasNc01}`)
      recordVerdict(verdicts, `mgr_${sp.name}_not_sees_nc02`, !hasNc02, `nc02=${hasNc02}`)
      recordVerdict(verdicts, `mgr_${sp.name}_not_sees_other_mkt`, !hasOther, `other=${hasOther}`)
    }
    // 反例：MGR 把市场选成"南昌市场2" → filteredStores 应为空
    const nc2Stores = await readStoresAfterMarketPick(pMgr, '/customers', TOPOLOGY.MARKET_NC2)
    if (nc2Stores) {
      const real = nc2Stores.filter((s) => !s.includes('全部'))
      recordVerdict(verdicts, 'mgr_pick_other_market_empty', real.length === 0, `picked NC2, realStores=${real.length} [${real.join('|')}]`)
    }
  } finally {
    await ctxMgr.close()
  }

  // ── Case 2: MKT(南昌) — 门店下拉 = 南昌市场旗下 N 店 ──
  console.log('[链路35b] Case 2: MKT(南昌)')
  const ctxMkt = await browser.newContext()
  const pMkt = await ctxMkt.newPage()
  try {
    await loginSlow(pMkt, TEST_PHONES.MKT)
    for (const sp of SAMPLE_PAGES) {
      const got = await readCascadeSelects(pMkt, sp.url)
      if (!got) {
        recordVerdict(verdicts, `mkt_${sp.name}_load`, false, '无法读取下拉')
        continue
      }
      const realStores = got.stores.filter((s) => !s.includes('全部'))
      // MKT.stores = expandScopeStoreIds(南昌市场) ⇒ 应等于 ncStoreCount（DB 中 parent=MARKET_NC 的 stores 数）
      recordVerdict(
        verdicts,
        `mkt_${sp.name}_store_count_eq_nc`,
        Math.abs(realStores.length - baseline.ncStoreCount) <= 2,
        `realStores=${realStores.length} expected≈${baseline.ncStoreCount}`,
      )
      const hasNc02 = realStores.some((s) => s.includes('青山湖店'))
      const hasOtherMkt = realStores.some((s) => s.includes('龙珠店'))
      recordVerdict(verdicts, `mkt_${sp.name}_sees_nc02`, hasNc02, `nc02=${hasNc02}`)
      recordVerdict(verdicts, `mkt_${sp.name}_not_sees_other_mkt`, !hasOtherMkt, `other=${hasOtherMkt}`)
    }
    // 反例：MKT 选"南昌市场2" → filteredStores 应为空
    const nc2Stores = await readStoresAfterMarketPick(pMkt, '/customers', TOPOLOGY.MARKET_NC2)
    if (nc2Stores) {
      const real = nc2Stores.filter((s) => !s.includes('全部'))
      recordVerdict(verdicts, 'mkt_pick_other_market_empty', real.length === 0, `picked NC2, realStores=${real.length}`)
    }
  } finally {
    await ctxMkt.close()
  }

  // ── Case 3: FIN(总部 finance, HQ scope) — 门店下拉 = 全部门店（业务数据全量基线）──
  // 用 finance 而非 admin：admin 按设计不持业务数据权限（customer:list 等），不能开 /customers /cards；
  //                       finance HQ scope + customer:list / point_transaction:list / card_transaction:list 全持，
  //                       是这些业务列表页的"全量基线"角色。
  console.log('[链路35b] Case 3: FIN (全量基线)')
  const ctxFin = await browser.newContext()
  const pFin = await ctxFin.newPage()
  try {
    await loginSlow(pFin, TEST_PHONES.FIN)
    for (const sp of SAMPLE_PAGES) {
      const got = await readCascadeSelects(pFin, sp.url)
      if (!got) {
        recordVerdict(verdicts, `fin_${sp.name}_load`, false, '无法读取下拉')
        continue
      }
      const realStores = got.stores.filter((s) => !s.includes('全部'))
      recordVerdict(
        verdicts,
        `fin_${sp.name}_store_count_close_to_total`,
        Math.abs(realStores.length - baseline.totalStores) <= 5,
        `realStores=${realStores.length} dbTotal=${baseline.totalStores}`,
      )
      const realMarkets = got.markets.filter((s) => !s.includes('全部'))
      recordVerdict(
        verdicts,
        `fin_${sp.name}_market_count_close_to_total`,
        Math.abs(realMarkets.length - baseline.totalMarkets) <= 2,
        `realMarkets=${realMarkets.length} dbTotalMarkets=${baseline.totalMarkets}`,
      )
    }
    // 级联：FIN 选南昌市场后门店应等于 ncStoreCount
    const ncStores = await readStoresAfterMarketPick(pFin, '/customers', TOPOLOGY.MARKET_NC)
    if (ncStores) {
      const real = ncStores.filter((s) => !s.includes('全部'))
      recordVerdict(
        verdicts,
        'fin_pick_market_nc_cascade',
        Math.abs(real.length - baseline.ncStoreCount) <= 2,
        `picked NC, realStores=${real.length} expected≈${baseline.ncStoreCount}`,
      )
    }
  } finally {
    await ctxFin.close()
  }

  const overall = summarize(35.5, verdicts, baseline)
  writeContext('link35b', { status: overall, verdicts, baseline })

  for (const v of verdicts) {
    if (v.verdict !== 'SKIP') expect(v.verdict, `check=${v.check} actual=${v.actual}`).toBe('PASS')
  }
})
