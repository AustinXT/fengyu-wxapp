/**
 * 链路 35：级联下拉选择器约束
 *
 * 主题：admin 多个表单（订单创建、员工编辑、分配管理）使用 store 下拉，
 *       下拉选项应被 server-side scope 过滤：
 *         - 店长 nc01（FY-TEST-MGR）→ 只见 store-nc01
 *         - 店长 nc02（FY-TEST-MGR2）→ 只见 store-nc02
 *         - 市场经理（FY-TEST-MKT）→ 见 store-nc01 + store-nc02（南昌市场内的所有店）
 *         - admin（FY-TEST-ADM）→ 见全部门店
 *
 * 实现：
 *   1. 顾客 fixture FY-FIX-CLIENT-01 → 走 /orders/create 顾客搜索 → 下一步 → 商品分类 → 加购 → Step3 结算
 *   2. 抓 Step3 的「门店」select option labels
 *   3. 与期望集合比对
 *
 * 简化：复杂的反例（DevTools 注入 storeId）需要 server action 拦截，由 link-37 覆盖。
 *       本链路聚焦 UI 下拉可见范围。
 *
 * 关键引用：
 *   - actions/stores.ts:48-60 getStores + scopeCondition(stores.storeId)
 *   - lib/permissions.ts:189-231 expandScopeStoreIds()
 */

import { test, expect } from '@playwright/test'
import {
  TEST_PHONES, TOPOLOGY,
  psql, login, recordVerdict, summarize, writeContext, type Verdict,
} from './_helpers/scope-helpers'

/**
 * 浏览到订单创建向导的 Step 3（结算页），返回此时门店 select 的 option label 列表。
 * 若过程中卡住或没有 Step 3，返回 null。
 */
async function readStoreSelectAtStep3(page: import('@playwright/test').Page, customerPhone: string): Promise<string[] | null> {
  await page.goto(`http://localhost:3000/orders/create`)
  await page.waitForLoadState('networkidle').catch(() => null)
  await page.waitForTimeout(1500)

  // Step1: 顾客搜索
  const phoneIn = page.getByPlaceholder(/手机号/).first()
  if (await phoneIn.count() === 0) return null
  await phoneIn.fill(customerPhone)
  const searchBtn = page.getByRole('button', { name: /搜索/ }).first()
  await searchBtn.click().catch(() => null)
  await page.waitForFunction(() => /找到|未找到/.test(document.body.textContent || ''), { timeout: 15000 }).catch(() => null)
  const firstCustomerBtn = page.locator('div.space-y-1 > button').first()
  if (await firstCustomerBtn.count() === 0) return null
  await firstCustomerBtn.click()
  await page.getByRole('button', { name: '下一步' }).first().click().catch(() => null)

  // Step2: 商品列表 → 加购
  await page.waitForTimeout(2500)
  const addBtn = page.getByRole('button', { name: /加入/ }).first()
  if (await addBtn.count() > 0) await addBtn.click()
  await page.waitForTimeout(500)
  await page.getByRole('button', { name: '下一步' }).first().click().catch(() => null)

  // Step3: 结算页 — 找门店 select
  await page.waitForTimeout(2000)
  // select 通常以 <select> 渲染（Select 组件），上方 label 是「门店」
  const storeSelect = page.locator('label:has-text("门店") + * select, label:has-text("门店") ~ select').first()
  // 备选：在「指定美容师」label 之上有「门店」label，匹配「label:text("门店")」 + 紧邻的 select
  let labels: string[] = []
  if (await storeSelect.count() > 0) {
    labels = await storeSelect.locator('option').allTextContents()
  } else {
    // 降级：抓所有 select，每个 select 抓 option，看哪个 select 包含「店」字
    const allSelects = await page.locator('select').all()
    for (const sel of allSelects) {
      const opts = await sel.locator('option').allTextContents()
      if (opts.some((o) => o.includes('店') || o.includes('南昌'))) {
        labels = opts
        break
      }
    }
  }
  return labels.map((l) => l.trim()).filter(Boolean)
}

test.setTimeout(240_000)

test('链路35：级联下拉选择器约束', async ({ browser }) => {
  const verdicts: Verdict[] = []

  // ── 预备：DB 层 invariant — 各角色 expandScopeStoreIds 的预期门店集合 ──
  const mktStores = psql(`
    SELECT store_id FROM stores s
    JOIN org_nodes o ON s.org_node_id=o.id
    WHERE o.parent_id='${TOPOLOGY.MARKET_NC}'
    ORDER BY store_id
  `).split('\n').map((x) => x.trim()).filter(Boolean)

  console.log(`[链路35] mkt scope stores: ${mktStores.length} (含 nc01+nc02 在内)`)

  // ── Case 1: 店长 nc01（FY-TEST-MGR）── 下拉应只见 store-nc01
  console.log('[链路35] Case 1: 店长 nc01')
  const ctxMgr = await browser.newContext()
  const pMgr = await ctxMgr.newPage()
  try {
    await login(pMgr, TEST_PHONES.MGR)
    const mgrLabels = await readStoreSelectAtStep3(pMgr, '13800138000')
    if (mgrLabels === null) {
      recordVerdict(verdicts, 'mgr_reaches_step3', false, '无法到达 Step3')
    } else {
      recordVerdict(verdicts, 'mgr_reaches_step3', true, `option count=${mgrLabels.length}`)
      // 应只含 store-nc01 名字（南昌旗舰店），不含 store-nc02（青山湖店）或其他市场门店
      const seesNc01 = mgrLabels.some((l) => l.includes('南昌旗舰店'))
      const seesNc02 = mgrLabels.some((l) => l.includes('青山湖店'))
      const seesOther = mgrLabels.some((l) => l.includes('龙珠店') || l.includes('天街店'))
      recordVerdict(verdicts, 'mgr_sees_nc01', seesNc01, `labels=${mgrLabels.join(',')}`)
      recordVerdict(verdicts, 'mgr_not_sees_nc02', !seesNc02, `seesNc02=${seesNc02}`)
      recordVerdict(verdicts, 'mgr_not_sees_other_market', !seesOther, `seesOther=${seesOther}`)
    }
  } finally {
    await ctxMgr.close()
  }

  // ── Case 2: 市场经理（FY-TEST-MKT）── 下拉应见 store-nc01 + store-nc02，不见 market_nc2 门店
  console.log('[链路35] Case 2: 市场经理')
  const ctxMkt = await browser.newContext()
  const pMkt = await ctxMkt.newPage()
  try {
    await login(pMkt, TEST_PHONES.MKT)
    const mktLabels = await readStoreSelectAtStep3(pMkt, '13800138000')
    if (mktLabels === null) {
      recordVerdict(verdicts, 'mkt_reaches_step3', false, '无法到达 Step3')
    } else {
      recordVerdict(verdicts, 'mkt_reaches_step3', true, `option count=${mktLabels.length}`)
      const seesNc01 = mktLabels.some((l) => l.includes('南昌旗舰店'))
      const seesNc02 = mktLabels.some((l) => l.includes('青山湖店'))
      const seesOther = mktLabels.some((l) => l.includes('龙珠店'))
      recordVerdict(verdicts, 'mkt_sees_nc01', seesNc01, `seesNc01=${seesNc01}`)
      recordVerdict(verdicts, 'mkt_sees_nc02', seesNc02, `seesNc02=${seesNc02}`)
      recordVerdict(verdicts, 'mkt_not_sees_other_market', !seesOther, `seesOther=${seesOther}`)
    }
  } finally {
    await ctxMkt.close()
  }

  // ── Case 3: admin ── 下拉应见全部门店（含其他市场）
  console.log('[链路35] Case 3: admin')
  const ctxAdm = await browser.newContext()
  const pAdm = await ctxAdm.newPage()
  try {
    await login(pAdm, TEST_PHONES.ADM)
    const admLabels = await readStoreSelectAtStep3(pAdm, '13800138000')
    if (admLabels === null) {
      recordVerdict(verdicts, 'adm_reaches_step3', false, '无法到达 Step3')
    } else {
      recordVerdict(verdicts, 'adm_reaches_step3', true, `option count=${admLabels.length}`)
      const seesNc01 = admLabels.some((l) => l.includes('南昌旗舰店'))
      const seesNc02 = admLabels.some((l) => l.includes('青山湖店'))
      const seesOther = admLabels.some((l) => l.includes('龙珠店') || l.includes('天街店'))
      const totalStores = parseInt(psql(`SELECT COUNT(*)::text FROM stores`), 10)
      recordVerdict(verdicts, 'adm_sees_nc01', seesNc01, `seesNc01=${seesNc01}`)
      recordVerdict(verdicts, 'adm_sees_nc02', seesNc02, `seesNc02=${seesNc02}`)
      recordVerdict(verdicts, 'adm_sees_other_market', seesOther, `seesOther=${seesOther}`)
      recordVerdict(
        verdicts, 'adm_option_count_close_to_total',
        Math.abs(admLabels.length - totalStores) <= 5,
        `adm options=${admLabels.length}, db total=${totalStores}`,
      )
    }
  } finally {
    await ctxAdm.close()
  }

  const overall = summarize(35, verdicts, { mkt_scope_store_count: mktStores.length })
  writeContext('link35', { status: overall, verdicts })

  for (const v of verdicts) {
    if (v.verdict !== 'SKIP') expect(v.verdict, `check=${v.check} actual=${v.actual}`).toBe('PASS')
  }
})
