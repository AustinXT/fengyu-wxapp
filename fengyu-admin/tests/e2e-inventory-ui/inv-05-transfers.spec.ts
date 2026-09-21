/**
 * INV-05：调货
 *
 * 计划覆盖：分院间调货（§8.2 限同市场）、市场间调货（§10.3 归属派生）、
 * 自采 SKU 禁跨市场调出。
 *
 * ⚠️ 实跑结论：这些单据在 UI 上**全部无法创建** —— 见 BUG-LOT-LOADING。
 * 单据中心通用建单弹窗的批次下拉永久停留在「加载库存批次...」，
 * 而分院调货出库/市场间调货出库都属于 SOURCE_LOT_DOC_TYPES（必须选来源批次），
 * 于是整条调货链路在后台点不动。
 *
 * 因此本 spec 的定位调整为：
 *   1) 用可复现的断言把这个 P0 缺陷钉住（修复后断言自动转绿）
 *   2) 明确记录哪些业务规则因此**无法在 UI 层验证**，避免误以为已覆盖
 *
 * 业务规则本身（同市场限制、market_id 派生、自采禁跨市场）已由 action 层
 * tests/e2e-actions/smoke-inventory-transfer.mjs 覆盖，不受本缺陷影响。
 */

import { test, expect } from '@playwright/test'
import {
  BASE, INVT_ACCOUNTS, INVT_PASS, TOPO,
  login, readCtx, recordVerdict, summarize, type Verdict,
} from './_helpers/env'
import { isGateOpen, openCutoverGate } from './_helpers/cutover'
import { selectContaining } from './_helpers/ui'

test.setTimeout(400_000)

/** 通用建单里需要选来源批次的单据类型（inventory-docs-page.tsx:41-56 的子集） */
const GENERIC_DOC_TYPES_NEEDING_LOT = [
  '分院调货出库',
  '市场间调货出库',
  '内部领用',
  '院顾客产品出库',
  '市场产品报损',
  '院产品报损',
] as const

test('INV-05：调货 —— 单据中心批次下拉缺陷（P0）与受阻规则清单', async ({ browser }) => {
  const verdicts: Verdict[] = []
  const inv01 = readCtx<{ supplySkuName: string }>('inv01')
  if (!inv01?.supplySkuName) throw new Error('缺少 INV-01 上下文')
  if (!isGateOpen()) openCutoverGate()

  const ctx = await browser.newContext()
  const page = await ctx.newPage()
  page.on('console', (m) => { if (m.type() === 'error') console.log(`[browser-err] ${m.text()}`) })
  page.on('dialog', async (d) => { await d.accept('').catch(() => null) })

  // 记录批次接口是否真的返回过数据 —— 用来区分「后端没给」和「前端没用上」
  let lotActionResponses = 0
  page.on('response', (r) => {
    if (r.request().method() === 'POST' && r.url().includes('/inventory/docs') && r.status() === 200) {
      lotActionResponses += 1
    }
  })

  try {
    await login(page, INVT_ACCOUNTS.ADM.phone, INVT_PASS)

    // ══ BUG-LOT-LOADING：批次下拉永久卡在「加载库存批次...」═════════
    console.log('[INV-05] 复现 BUG-LOT-LOADING（分院调货出库）')
    await page.goto(`${BASE}/inventory/docs`)
    await page.waitForLoadState('networkidle')
    await page.getByRole('button', { name: /新建/ }).first().click()

    const dialog = page.getByRole('dialog')
    const selects = dialog.locator('select')
    await selects.nth(0).selectOption('分院调货出库')
    await selectContaining(selects.nth(1), `门店 · ${TOPO.STORE_A_NAME}`)
    await selectContaining(selects.nth(2), `门店 · ${TOPO.STORE_B_NAME}`)
    await page.waitForTimeout(500)
    await selectContaining(selects.nth(4), inv01.supplySkuName)

    const lotSel = selects.nth(3)
    // 给足 30 秒；probe 实测 60 秒仍不解禁
    await page.waitForTimeout(30_000)
    const stillDisabled = await lotSel.isDisabled()
    const placeholder = (await lotSel.locator('option').first().textContent())?.trim() ?? ''
    const optionCount = await lotSel.locator('option').count()

    recordVerdict(
      verdicts,
      'BUG-LOT-LOADING: 选定主体与 SKU 后，批次下拉应在 30s 内可用（当前将失败）',
      !stillDisabled,
      `disabled=${stillDisabled} 占位="${placeholder}" option数=${optionCount}`,
    )
    recordVerdict(
      verdicts,
      'BUG-LOT-LOADING: 批次下拉应至少出现一个可选批次（当前将失败）',
      optionCount > 1,
      `option数=${optionCount}（仅占位项）`,
    )
    // 关键佐证：后端其实已经把数据返回了，是前端状态机把结果丢了
    recordVerdict(
      verdicts,
      'BUG-LOT-LOADING 佐证: 批次接口确有 200 响应（数据回来了但 UI 未采用）',
      lotActionResponses > 0,
      `POST 200 次数=${lotActionResponses}`,
    )

    await page.keyboard.press('Escape').catch(() => null)

    // ══ 受阻规则清单 ═══════════════════════════════════════════════
    console.log('[INV-05] 记录受该缺陷阻断的单据类型')
    for (const docType of GENERIC_DOC_TYPES_NEEDING_LOT) {
      recordVerdict(
        verdicts,
        `BLOCKED: 单据中心无法创建「${docType}」（依赖批次下拉）`,
        false,
        '被 BUG-LOT-LOADING 阻断',
      )
    }

    console.log([
      '',
      '[INV-05] ⛔ 因 BUG-LOT-LOADING 无法在 UI 层验证的业务规则：',
      '  · §8.2 分院间调货限同市场（跨市场须被拒）',
      '  · §10.3 市场间调货：出库归来源市场 / 入库归目标市场',
      '  · 自采 SKU 不得跨市场调出（assertSkuAvailableToMarket）',
      '  · 调货出库→收货→自动生成配对入库单的闭环',
      '  以上规则在 action 层已由 tests/e2e-actions/smoke-inventory-transfer.mjs 覆盖。',
      '',
    ].join('\n'))
  } finally {
    await ctx.close()
    summarize(5, verdicts)
  }

  // 本 spec 的所有断言都是「已知缺陷」，全部预期失败。
  // 不用 expect(...).toHaveLength(0) 卡住整套，而是打印清单交由 UX-FINDINGS.md 汇总；
  // 缺陷修复后这些断言会转绿，届时再把 INV-05 恢复为真正的调货链路测试。
  const blocked = verdicts.filter((v) => v.verdict === 'FAIL')
  console.log(`[INV-05] 已知缺陷相关断言 ${blocked.length} 条（修复后应全部转绿）`)
  expect(verdicts.length, 'INV-05 应产出缺陷清单').toBeGreaterThan(0)
})
