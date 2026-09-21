/**
 * INV-09：单据中心与库存台账
 *
 * 重点是两个**语义相反**的组织树筛选（admin.ui.spec.md:151）：
 *   · 单据中心（/inventory/docs?orgNodeId=）选上级 → **包含全部后代**的单据
 *   · 库存查询（/inventory/stocks?location=）选上级 → **只出该主体自身**，不汇总下级
 * 这两处最容易实现反，所以放在一起对照断言。
 *
 * 另覆盖：33 种类型 / 6 种状态筛选项齐全、关键字搜索、单据详情的血缘表与履约进度、
 * 分页与总数、导出入口。
 */

import { test, expect } from '@playwright/test'
import {
  BASE, INVT_ACCOUNTS, INVT_PASS, TOPO,
  login, psql, readCtx, recordVerdict, sqlStr, summarize, type Verdict,
} from './_helpers/env'

test.setTimeout(600_000)

/** DB 事实：33 种单据类型、6 种状态（0009 CHECK 约束的字面量） */
const EXPECTED_DOC_TYPE_COUNT = 33
const EXPECTED_STATUSES = ['草稿', '待审批', '待收货', '已完成', '已驳回', '已取消']

test('INV-09：单据中心筛选 / 血缘 / 台账两种筛选语义', async ({ browser }) => {
  const verdicts: Verdict[] = []
  const inv03 = readCtx<{ storeReqId: string; marketReqId: string; poId: string; allocId: string; skuName: string }>('inv03')

  const ctx = await browser.newContext()
  const page = await ctx.newPage()
  page.on('console', (m) => { if (m.type() === 'error') console.log(`[browser-err] ${m.text()}`) })
  page.on('dialog', async (d) => { await d.accept('').catch(() => null) })

  try {
    await login(page, INVT_ACCOUNTS.ADM.phone, INVT_PASS)

    // ══ 1. 筛选项完整性 ═══════════════════════════════════════════
    console.log('[INV-09] 1 筛选项完整性')
    await page.goto(`${BASE}/inventory/docs`)
    await page.waitForLoadState('networkidle')
    await page.waitForTimeout(1000)

    const typeSelect = page.locator('main select').filter({ hasText: '全部单据' }).first()
    const typeOptions = await typeSelect.locator('option').allTextContents()
    recordVerdict(
      verdicts,
      `筛选: 单据类型下拉含全部 ${EXPECTED_DOC_TYPE_COUNT} 种（含「全部单据」共 ${EXPECTED_DOC_TYPE_COUNT + 1} 项）`,
      typeOptions.length === EXPECTED_DOC_TYPE_COUNT + 1,
      `实际 ${typeOptions.length - 1} 种`,
    )
    // 与 DB CHECK 约束比对，防止 UI 常量与 DB 约束漂移
    const dbTypeCount = psql(
      `SELECT array_length(
                string_to_array(
                  regexp_replace(pg_get_constraintdef(oid), '.*ARRAY\\[|\\]\\)\\)$|::text', '', 'g'),
                  ', '), 1)
         FROM pg_constraint WHERE conname = 'chk_inventory_docs_type'`,
    )
    recordVerdict(
      verdicts,
      '筛选: UI 类型数与 DB CHECK 约束一致（防常量漂移）',
      Number(dbTypeCount) === typeOptions.length - 1,
      `DB=${dbTypeCount} UI=${typeOptions.length - 1}`,
    )

    const statusSelect = page.locator('main select').filter({ hasText: '全部状态' }).first()
    const statusOptions = (await statusSelect.locator('option').allTextContents()).map((t) => t.trim())
    for (const st of EXPECTED_STATUSES) {
      recordVerdict(verdicts, `筛选: 状态下拉含「${st}」`, statusOptions.includes(st), statusOptions.join('/'))
    }

    // ══ 2. 关键字搜索（300ms 防抖）════════════════════════════════
    console.log('[INV-09] 2 关键字搜索')
    if (inv03?.marketReqId) {
      await page.goto(`${BASE}/inventory/docs?q=${encodeURIComponent(inv03.marketReqId)}`)
      await page.waitForLoadState('networkidle')
      await page.waitForTimeout(1200)
      const main = await page.locator('main').innerText()
      recordVerdict(verdicts, `搜索: 按单据号命中 ${inv03.marketReqId}`, main.includes(inv03.marketReqId), '命中')
      recordVerdict(
        verdicts,
        '搜索: 结果页显示总数',
        /共\s*\d+\s*条|第\s*1\s*页/.test(main),
        /共\s*\d+\s*条/.exec(main)?.[0] ?? '未见总数文案',
      )
    }

    // ══ 3. 状态筛选与 DB 一致 ═════════════════════════════════════
    console.log('[INV-09] 3 状态筛选结果与 DB 核对')
    await page.goto(`${BASE}/inventory/docs?status=${encodeURIComponent('待收货')}&size=100`)
    await page.waitForLoadState('networkidle')
    await page.waitForTimeout(1500)
    const pendingText = await page.locator('main').innerText()
    const dbPendingIds = psql(
      `SELECT COALESCE(string_agg(id, ','), '') FROM (
         SELECT id FROM inventory_docs WHERE status = '待收货' ORDER BY created_at DESC LIMIT 5
       ) t`,
    ).split(',').filter(Boolean)
    if (dbPendingIds.length > 0) {
      const allShown = dbPendingIds.every((id) => pendingText.includes(id))
      recordVerdict(
        verdicts,
        '筛选: 「待收货」结果覆盖 DB 中最近 5 张待收货单',
        allShown,
        allShown ? '全部命中' : `缺失 ${dbPendingIds.filter((id) => !pendingText.includes(id)).join(',')}`,
      )
      // 反向：结果里不应混入已完成单
      const doneId = psql(`SELECT COALESCE(id,'') FROM inventory_docs WHERE status='已完成' ORDER BY created_at DESC LIMIT 1`)
      if (doneId) {
        recordVerdict(
          verdicts,
          '筛选: 「待收货」结果不混入已完成单',
          !pendingText.includes(doneId),
          doneId,
        )
      }
    } else {
      recordVerdict(verdicts, '筛选: 「待收货」核对（跳过：库中暂无待收货单）', true, 'skip')
    }

    // ══ 4. 两种组织树筛选的相反语义（admin.ui.spec.md:151）══════════
    console.log('[INV-09] 4 组织树筛选语义对照')
    // 4a 单据中心：选市场 → 应含其下门店的单据
    const storeDocId = psql(
      `SELECT COALESCE(id,'') FROM inventory_docs
        WHERE (source_org_node_id = ${sqlStr(TOPO.STORE_A_ORG)} OR target_org_node_id = ${sqlStr(TOPO.STORE_A_ORG)})
        ORDER BY created_at DESC LIMIT 1`,
    )
    if (storeDocId) {
      await page.goto(`${BASE}/inventory/docs?orgNodeId=${encodeURIComponent(TOPO.MARKET)}&size=100&q=${encodeURIComponent(storeDocId)}`)
      await page.waitForLoadState('networkidle')
      await page.waitForTimeout(1500)
      const docsText = await page.locator('main').innerText()
      recordVerdict(
        verdicts,
        '★ 单据中心：选市场应**包含**其下门店的单据',
        docsText.includes(storeDocId),
        docsText.includes(storeDocId) ? `命中门店单据 ${storeDocId}` : `未含 ${storeDocId}`,
      )
    }

    // 4b 库存查询：选市场 → 只出市场自身库存，不汇总门店
    await page.goto(`${BASE}/inventory/stocks?location=${encodeURIComponent(TOPO.MARKET)}&size=100`)
    await page.waitForLoadState('networkidle')
    await page.waitForTimeout(1500)
    const stocksText = await page.locator('main').innerText()
    // 只看**表格数据行**，不能看整个 main：筛选器下拉本身会列出全部可选主体
    // （包含各门店），拿 main 全文匹配会把下拉选项误判成"汇总了门店库存"。
    const stocksRows = (await page.locator('tbody tr').allInnerTexts()).join('\n')
    recordVerdict(
      verdicts,
      `★ 库存查询：选市场只出本主体，**不汇总**下级门店「${TOPO.STORE_A_NAME}」`,
      !stocksRows.includes(TOPO.STORE_A_NAME),
      stocksRows.includes(TOPO.STORE_A_NAME) ? '数据行里出现了门店库存' : '数据行未含门店（正确）',
    )
    recordVerdict(
      verdicts,
      '库存查询：数据行可见所选市场自身',
      stocksRows.includes(TOPO.MARKET_NAME) || stocksRows.trim() === '',
      stocksRows.includes(TOPO.MARKET_NAME) ? '可见' : `数据行=${stocksRows.slice(0, 60).replace(/\n/g, ' / ')}`,
    )
    recordVerdict(
      verdicts,
      '库存查询：表头含「可用量」列（在手 − 未完成预留）',
      /可用量/.test(stocksText),
      /可用量/.test(stocksText) ? '有' : '缺失',
    )
    recordVerdict(
      verdicts,
      '库存查询：无 null/undefined/NaN 泄漏',
      !/\bnull\b|\bundefined\b|\bNaN\b/.test(stocksText),
      'clean',
    )

    // ══ 5. 单据详情：血缘表与履约进度 ══════════════════════════════
    console.log('[INV-09] 5 单据详情血缘')
    if (inv03?.poId) {
      await page.goto(`${BASE}/inventory/docs/${inv03.poId}`)
      await page.waitForLoadState('networkidle')
      await page.waitForTimeout(1500)
      const detail = await page.locator('main').innerText()
      recordVerdict(verdicts, '详情: 展示单据号', detail.includes(inv03.poId), inv03.poId)
      recordVerdict(
        verdicts,
        '详情: 展示关联单据血缘',
        /关联单据|上游|下游|血缘|关系/.test(detail),
        /关联单据|上游|下游|血缘|关系/.test(detail) ? '有血缘区块' : '未见血缘区块',
      )
      // 采购订单的上游是市场报货单，应能在详情里看到
      if (inv03.marketReqId) {
        recordVerdict(
          verdicts,
          '详情: 血缘里能看到上游市场报货单',
          detail.includes(inv03.marketReqId),
          detail.includes(inv03.marketReqId) ? `含 ${inv03.marketReqId}` : '未含上游单号',
        )
      }
      recordVerdict(
        verdicts,
        '详情: 无 null/undefined/NaN 泄漏',
        !/\bnull\b|\bundefined\b|\bNaN\b/.test(detail),
        'clean',
      )
    }

    // ══ 6. 导出入口 ═══════════════════════════════════════════════
    console.log('[INV-09] 6 导出入口')
    await page.goto(`${BASE}/inventory/stocks`)
    await page.waitForLoadState('networkidle')
    await page.waitForTimeout(1000)
    const exportBtn = await page.getByRole('button', { name: /导出/ }).count()
    recordVerdict(verdicts, '台账: 提供导出入口（需 inventory:export）', exportBtn > 0, `导出按钮数=${exportBtn}`)
  } finally {
    await ctx.close()
    summarize(9, verdicts)
  }

  const known = verdicts.filter((v) => v.verdict === 'FAIL' && /^(BLOCKED:|BUG-|UX-)/.test(v.check))
  const functional = verdicts.filter((v) => v.verdict === 'FAIL' && !/^(BLOCKED:|BUG-|UX-)/.test(v.check))
  if (known.length > 0) console.log(`\n[INV-09] ⛔ 已知缺陷:\n${JSON.stringify(known, null, 2)}`)
  expect(functional, `INV-09 功能失败项:\n${JSON.stringify(functional, null, 2)}`).toHaveLength(0)
})
