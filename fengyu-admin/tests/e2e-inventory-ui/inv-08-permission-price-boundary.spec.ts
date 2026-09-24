/**
 * INV-08：权限与价格档边界（P0 安全）
 *
 * 说明.md §9 / §10.4 的硬约束，逐条在 UI 上验证：
 *   §9.1 进销存用独立角色，店长/财务/商品等历史角色不自动放权
 *   §9.2 总部 scope **只含总部库存，不自动展开**市场和门店；
 *        市场 scope 含本市场及其门店；门店 scope 只含本门店
 *   §9.4 单据按实际参与主体可见，跨市场互不可见
 *   §9.5 价格按层级分隔；未获对应价格权限时**接口也不返回**被遮蔽字段
 *
 * ⚠️ 门店档位（§9.5「门店不展示金额」）在 admin 上无法验证：
 * inventory_store_operator.can_access_admin = false（migration 0039），
 * 门店库存员根本登不进后台 —— 该口径需在 staff 小程序侧覆盖。本 spec 会把
 * 「登不进后台」这件事本身断言下来。
 */

import { test, expect } from '@playwright/test'
import {
  BASE, INVT_ACCOUNTS, INVT_PASS, TOPO,
  login, tryLogin, psql, readCtx, recordVerdict, sqlStr, summarize, type Verdict,
} from './_helpers/env'

test.setTimeout(600_000)

/** 访问一个页面，返回 HTTP 状态与可见文本 */
async function visit(page: import('@playwright/test').Page, path: string) {
  const resp = await page.goto(`${BASE}${path}`, { waitUntil: 'domcontentloaded' }).catch(() => null)
  await page.waitForLoadState('networkidle').catch(() => null)
  await page.waitForTimeout(1200)
  const text = (await page.locator('body').innerText().catch(() => '')) || ''
  return { status: resp?.status() ?? 0, text, url: page.url() }
}

function denied(r: { status: number; text: string; url: string }, path: string): boolean {
  if (r.status >= 400) return true
  if (/权限不足|没有权限|无权访问|PERMISSION_DENIED|此页面找不到|404 This page/.test(r.text)) return true
  // 被重定向走了也算拒绝
  return !new URL(r.url).pathname.startsWith(path)
}

test('INV-08：三级 scope 隔离与价格档裁剪', async ({ browser }) => {
  const verdicts: Verdict[] = []
  const inv01 = readCtx<{ supplySkuName: string }>('inv01')
  const inv03 = readCtx<{ shipId: string; marketReqId: string }>('inv03')

  try {
    // ══ 1. 门店库存员不得登录 admin（0039 硬约束）═══════════════════
    console.log('[INV-08] 1 门店库存员登录 admin')
    {
      const ctx = await browser.newContext()
      const page = await ctx.newPage()
      const r = await tryLogin(page, INVT_ACCOUNTS.ST.phone, INVT_PASS)
      recordVerdict(
        verdicts,
        '§9.1 门店库存员无法登录 admin（can_access_admin=false）',
        !r.ok,
        r.ok ? `不该登进却进了：${r.url}` : `被拒，停留在 ${new URL(r.url).pathname}`,
      )
      await ctx.close()
    }

    // ══ 2. 供应链库存员：只能进供应链办理台 ════════════════════════
    console.log('[INV-08] 2 供应链库存员的层级边界与 scope')
    {
      const ctx = await browser.newContext()
      const page = await ctx.newPage()
      await login(page, INVT_ACCOUNTS.SC.phone, INVT_PASS)

      const own = await visit(page, '/inventory/operations/supply-chain')
      recordVerdict(verdicts, 'SC: 可进供应链办理台', !denied(own, '/inventory/operations/supply-chain'), `status=${own.status}`)

      const mk = await visit(page, '/inventory/operations/market')
      recordVerdict(verdicts, '§9.1 SC: 不可进市场办理台', denied(mk, '/inventory/operations/market'), `status=${mk.status}`)

      const st = await visit(page, '/inventory/operations/store')
      recordVerdict(verdicts, '§9.1 SC: 不可进门店办理台', denied(st, '/inventory/operations/store'), `status=${st.status}`)

      // §9.2 总部 scope 不下钻：库存查询里不应出现市场/门店的库存主体
      const stocks = await visit(page, '/inventory/stocks')
      recordVerdict(verdicts, 'SC: 可看库存查询', !denied(stocks, '/inventory/stocks'), `status=${stocks.status}`)
      recordVerdict(
        verdicts,
        `§9.2 SC: 库存查询不出现市场「${TOPO.MARKET_NAME}」的库存`,
        !stocks.text.includes(TOPO.MARKET_NAME),
        stocks.text.includes(TOPO.MARKET_NAME) ? '出现了市场库存（总部 scope 不应下钻）' : '未出现',
      )
      recordVerdict(
        verdicts,
        `§9.2 SC: 库存查询不出现门店「${TOPO.STORE_A_NAME}」的库存`,
        !stocks.text.includes(TOPO.STORE_A_NAME),
        stocks.text.includes(TOPO.STORE_A_NAME) ? '出现了门店库存' : '未出现',
      )
      await ctx.close()
    }

    // ══ 3. 市场库存财务：层级边界 + 跨市场隔离 ══════════════════════
    console.log('[INV-08] 3 市场库存财务的层级边界与跨市场隔离')
    {
      const ctx = await browser.newContext()
      const page = await ctx.newPage()
      await login(page, INVT_ACCOUNTS.MK.phone, INVT_PASS)

      const own = await visit(page, '/inventory/operations/market')
      recordVerdict(verdicts, 'MK: 可进市场办理台', !denied(own, '/inventory/operations/market'), `status=${own.status}`)

      const sc = await visit(page, '/inventory/operations/supply-chain')
      recordVerdict(verdicts, '§9.1 MK: 不可进供应链办理台', denied(sc, '/inventory/operations/supply-chain'), `status=${sc.status}`)

      // §9.2 市场 scope 含本市场及其门店
      const stocks = await visit(page, '/inventory/stocks')
      recordVerdict(
        verdicts,
        `§9.2 MK: 库存查询可见本市场「${TOPO.MARKET_NAME}」`,
        stocks.text.includes(TOPO.MARKET_NAME),
        stocks.text.includes(TOPO.MARKET_NAME) ? '可见' : '不可见（应可见）',
      )
      // §9.4 跨市场不可见
      recordVerdict(
        verdicts,
        `§9.4 MK: 库存查询不可见他市场「${TOPO.MARKET_OTHER_NAME}」`,
        !stocks.text.includes(TOPO.MARKET_OTHER_NAME),
        stocks.text.includes(TOPO.MARKET_OTHER_NAME) ? '泄漏了他市场库存' : '未泄漏',
      )

      // §9.4 单据可见性：他市场的单据不应出现在列表
      //
      // 「他市场单据」必须按**产品侧那条可见性规则**挑，而不是只看 market_id：
      // `listInventoryCoreDocs` 的过滤是 `source OR target IN scoped`
      // （engine.ts:2167），只要 MK 的市场（或其后代门店）是任一端，MK 就是这张单
      // 的合法参与方。
      //
      // 只按 market_id 挑会挑错：§10.3 规定市场间调货入库归属**收货**市场，于是
      // 「MK 发往他市场」的调货单 market_id 是他市场、source 却是 MK 自己 ——
      // 把 MK 看得见自己发出的单判成「泄漏」。旧写法一直绿，只是因为当时 inv-05
      // 从没真建出过市场间调货单，这条断言长期落在空集上。
      //
      // 优先取归属他市场的单；dev 上「自贡凤御」内部单据可能一张都没有，此时退到
      // **任何 MK 两端都不沾的单**（总部内部单等）—— 断言的实质是「非参与方看不到」，
      // 换个主体照样成立。一张都取不到时**不静默放过**：那意味着这条安全断言压根
      // 没跑，与 inv-10 的「ctx 缺失 → 报未覆盖」同一条纪律。
      const otherMarketRow = psql(
        `WITH RECURSIVE mine AS (
           SELECT id FROM org_nodes WHERE id = ${sqlStr(TOPO.MARKET)}
           UNION ALL
           SELECT n.id FROM org_nodes n JOIN mine ON n.parent_id = mine.id
         )
         SELECT d.id || '|' || COALESCE(d.market_id, '') FROM inventory_docs d
          WHERE COALESCE(d.source_org_node_id, '') NOT IN (SELECT id FROM mine)
            AND COALESCE(d.target_org_node_id, '') NOT IN (SELECT id FROM mine)
          ORDER BY COALESCE(d.market_id = ${sqlStr(TOPO.MARKET_OTHER)}, false) DESC,
                   d.created_at DESC
          LIMIT 1`,
      )
      const otherMarketDoc = otherMarketRow.split('|')[0]
      const subjectKind = otherMarketRow.endsWith(`|${TOPO.MARKET_OTHER}`)
        ? `他市场（${TOPO.MARKET_OTHER_NAME}）单据`
        : '非参与方单据'
      if (otherMarketDoc) {
        const docs = await visit(page, `/inventory/docs?q=${encodeURIComponent(otherMarketDoc)}`)
        recordVerdict(
          verdicts,
          `§9.4 MK: 搜不到${subjectKind} ${otherMarketDoc}`,
          !docs.text.includes(otherMarketDoc),
          docs.text.includes(otherMarketDoc) ? `泄漏了${subjectKind}` : '未泄漏',
        )
      } else {
        recordVerdict(
          verdicts,
          '§9.4 MK: 他市场单据可见性【未覆盖】',
          false,
          '库中找不到任何 MK 两端都不沾的单据，本条安全断言未实际执行',
        )
      }

      // §5.3/§10.4 品项公司发货单对市场不展示金额
      if (inv03?.shipId) {
        const detail = await visit(page, `/inventory/docs/${inv03.shipId}`)
        const shipAmount = psql(
          `SELECT COALESCE(total_amount::text,'NULL') FROM inventory_docs WHERE id = ${sqlStr(inv03.shipId)}`,
        )
        recordVerdict(
          verdicts,
          '§5.3/§10.4 MK: 品项公司发货单详情不展示金额',
          shipAmount === 'NULL' || shipAmount === '' || !detail.text.includes(shipAmount),
          `DB 金额=${shipAmount}；页面${detail.text.includes(shipAmount) ? '出现了该金额' : '未出现'}`,
        )
        recordVerdict(
          verdicts,
          'MK: 单据详情页无 null/undefined/NaN 泄漏',
          !/\bnull\b|\bundefined\b|\bNaN\b/.test(detail.text),
          'clean',
        )
      }

      // 货款结算页只含本市场
      const settle = await visit(page, '/inventory/settlements')
      recordVerdict(
        verdicts,
        '§9.4 MK: 结算页不出现他市场',
        !settle.text.includes(TOPO.MARKET_OTHER_NAME),
        settle.text.includes(TOPO.MARKET_OTHER_NAME) ? '泄漏' : '未泄漏',
      )
      await ctx.close()
    }

    // ══ 4. 价格档位：SC 与 MK 看到的价格字段不同（§9.5）═════════════
    console.log('[INV-08] 4 价格档位裁剪')
    if (inv01?.supplySkuName) {
      const readSkuPage = async (phone: string) => {
        const ctx = await browser.newContext()
        const page = await ctx.newPage()
        await login(page, phone, INVT_PASS)
        const r = await visit(page, `/inventory/skus?q=${encodeURIComponent(inv01.supplySkuName)}`)
        await ctx.close()
        return r.text
      }
      const scText = await readSkuPage(INVT_ACCOUNTS.SC.phone)
      const mkText = await readSkuPage(INVT_ACCOUNTS.MK.phone)

      // 供应链可见「供应链采购价」；市场不应见到它（§9.5 分层）
      recordVerdict(
        verdicts,
        '§9.5 SC: 可见供应链采购价列',
        /供应链采购价/.test(scText),
        /供应链采购价/.test(scText) ? '可见' : '不可见',
      )
      // 区分两件事：列**标题**渲染 vs 真实**数值**泄漏。
      // 只判标题会误报成安全问题 —— §9.5 的红线是「接口不返回被遮蔽字段」，
      // 也就是数值不能落到页面上；标题还在只是 UI 冗余。
      const scCost = psql(
        `SELECT COALESCE(supply_chain_purchase_price::text,'') FROM inventory_skus
          WHERE product_name = ${sqlStr(inv01.supplySkuName)}`,
      )
      const costLeaked = Boolean(scCost) && mkText.includes(scCost)
      recordVerdict(
        verdicts,
        '§9.5 MK: 供应链采购成本**数值**未泄漏（安全红线）',
        !costLeaked,
        costLeaked ? `页面出现了供应链采购价 ${scCost}` : `未出现（DB 值=${scCost}）`,
      )
      recordVerdict(
        verdicts,
        'UX-PRICE-COL: MK 视角不应渲染「供应链采购价」列标题（值已遮蔽，标题冗余）',
        !/供应链采购价/.test(mkText),
        /供应链采购价/.test(mkText) ? '列标题仍在渲染' : '未渲染',
      )
      recordVerdict(
        verdicts,
        '§9.5 MK: 可见市场进货价列',
        /市场进货价/.test(mkText),
        /市场进货价/.test(mkText) ? '可见' : '不可见（应可见）',
      )
    }
  } finally {
    summarize(8, verdicts)
  }

  // 豁免面收敛到 `/^UX-/`（原为 `/^(BLOCKED:|BUG-|UX-)/`，与 inv-06 / inv-07 一致）：
  // 本 spec 只有一条 `UX-PRICE-COL`，`BLOCKED:` 与 `BUG-` 两支从未出现过，
  // 留着等于给未来的安全边界回归预置一张豁免票。往这里加条目前先改这两行。
  const known = verdicts.filter((v) => v.verdict === 'FAIL' && /^UX-/.test(v.check))
  const functional = verdicts.filter((v) => v.verdict === 'FAIL' && !/^UX-/.test(v.check))
  if (known.length > 0) console.log(`\n[INV-08] ⛔ 已知缺陷:\n${JSON.stringify(known, null, 2)}`)
  expect(functional, `INV-08 安全边界失败项:\n${JSON.stringify(functional, null, 2)}`).toHaveLength(0)
})
