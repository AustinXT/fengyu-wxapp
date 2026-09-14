/**
 * INV-10：交互合理性审计
 *
 * 遍历 11 个库存页面 + 主要表单弹窗，跑一组启发式规则，产出
 * tests/e2e-inventory-ui/UX-FINDINGS.md（带证据的分级清单，供人工复核定性）。
 *
 * 这个 spec **不做通过/失败判定** —— 交互合理性是需要人判断的，
 * 自动扫描只负责把线索连同证据一条条摆出来。唯一的硬断言是「扫描本身跑完了」。
 */

import { test, expect } from '@playwright/test'
import * as fs from 'fs'
import * as path from 'path'
import { BASE, INVT_ACCOUNTS, INVT_PASS, login, readCtx } from './_helpers/env'
import { openOperation, selectByLabel, selectContaining, skuSelect } from './_helpers/ui'
import {
  checkForeignKeyInputs, checkLabelBinding, checkListAffordances, checkNumericGuards,
  checkRequiredMarkers, checkTechnicalLeak, extractFormControls, renderFindings,
  type Finding,
} from './_helpers/ux-audit'

test.setTimeout(900_000)

/** 库存域全部列表/报表页 */
const LIST_PAGES = [
  '/inventory/stocks',
  '/inventory/docs',
  '/inventory/settlements',
  '/inventory/skus',
  '/inventory/suppliers',
  '/inventory/sku-mappings',
  '/inventory/promotions',
] as const

/** 需要打开弹窗才能扫到表单的页面：[路径, 触发按钮名, 弹窗标题] */
const DIALOG_FORMS: Array<[string, RegExp, string]> = [
  ['/inventory/skus', /新建/, '新建库存商品'],
  ['/inventory/suppliers', /新建供应商/, '新建供应商'],
  ['/inventory/docs', /新建/, '新建库存单据'],
  ['/inventory/promotions', /新建/, '报货福利方案'],
]

/** 办理台表单：[层级, 卡片标题] */
const OPERATION_FORMS: Array<[string, string]> = [
  ['supply-chain', '品项公司报货需求'],
  ['supply-chain', '品项公司发货'],
  ['market', '市场退货申请'],
  ['market', '自采产品入库'],
  ['store', '门店报货'],
]

test('INV-10：交互合理性扫描 → UX-FINDINGS.md', async ({ browser }) => {
  const findings: Finding[] = []
  const inv01 = readCtx<{ supplySkuName: string }>('inv01')

  const ctx = await browser.newContext()
  const page = await ctx.newPage()
  page.on('console', (m) => { if (m.type() === 'error') console.log(`[browser-err] ${m.text()}`) })

  /** 原生弹窗全程计数 —— 现代后台不该再用 alert/confirm/prompt */
  const nativeDialogs: Array<{ type: string; message: string; where: string }> = []
  let currentPage = '(未知)'
  page.on('dialog', async (d) => {
    nativeDialogs.push({ type: d.type(), message: d.message().slice(0, 80), where: currentPage })
    await d.accept('').catch(() => d.dismiss().catch(() => null))
  })

  try {
    await login(page, INVT_ACCOUNTS.ADM.phone, INVT_PASS)

    // ══ A. 列表页：空态 / 分页 / 技术细节泄漏 ══════════════════════
    console.log('[INV-10] A 扫描列表页')
    for (const p of LIST_PAGES) {
      currentPage = p
      await page.goto(`${BASE}${p}`)
      await page.waitForLoadState('networkidle')
      await page.waitForTimeout(1200)
      const text = (await page.locator('main').innerText().catch(() => '')) || ''
      findings.push(...checkTechnicalLeak(text, p))
      findings.push(...(await checkListAffordances(page, p, { isReport: p === '/inventory/settlements' })))
    }

    // ══ B. 弹窗表单：控件选型 / 必填标记 / label 关联 / 数值约束 ════
    console.log('[INV-10] B 扫描弹窗表单')
    for (const [p, trigger, title] of DIALOG_FORMS) {
      currentPage = `${p} → ${title}`
      await page.goto(`${BASE}${p}`)
      await page.waitForLoadState('networkidle')
      const btn = page.getByRole('button', { name: trigger }).first()
      if (await btn.count() === 0) continue
      await btn.click()
      const dialog = page.getByRole('dialog')
      const shown = await dialog.waitFor({ state: 'visible', timeout: 10_000 }).then(() => true).catch(() => false)
      if (!shown) continue
      await page.waitForTimeout(800)

      const controls = await extractFormControls(dialog)
      findings.push(...checkForeignKeyInputs(controls, currentPage))
      findings.push(...checkLabelBinding(controls, currentPage))
      findings.push(...checkRequiredMarkers(controls, currentPage))
      findings.push(...(await checkNumericGuards(dialog, currentPage)))
      await page.keyboard.press('Escape').catch(() => null)
      await page.waitForTimeout(400)
    }

    // ══ C. 办理台表单 ═════════════════════════════════════════════
    console.log('[INV-10] C 扫描办理台表单')
    for (const [level, title] of OPERATION_FORMS) {
      currentPage = `/inventory/operations/${level} → ${title}`
      try {
        await openOperation(page, level, title)
      } catch {
        continue
      }
      await page.waitForTimeout(800)
      const form = page.locator('form').first()
      if (await form.count() === 0) continue
      const controls = await extractFormControls(form)
      findings.push(...checkForeignKeyInputs(controls, currentPage))
      findings.push(...checkRequiredMarkers(controls, currentPage))
      findings.push(...(await checkNumericGuards(form, currentPage)))
    }

    // ══ D. 提交反馈与防重复提交 ═══════════════════════════════════
    console.log('[INV-10] D 提交反馈与防重复提交')
    currentPage = '/inventory/operations/store → 门店报货'
    await openOperation(page, 'store', '门店报货')
    const submitBtn = page.locator('form').getByRole('button', { name: '创建门店报货单' })
    // 空表单直接提交：应给出可读的校验提示，而不是静默或技术错误
    await submitBtn.click()
    await page.waitForTimeout(2500)
    const toastText = ((await page.locator('[data-sonner-toast]').first().innerText().catch(() => '')) || '').replace(/\n/g, ' ')
    if (!toastText) {
      findings.push({
        rule: '提交无反馈',
        severity: 'P1',
        page: currentPage,
        detail: '空表单提交后没有任何可见提示，用户不知道为什么没反应',
      })
    } else {
      findings.push(...checkTechnicalLeak(toastText, `${currentPage}（校验提示）`))
    }

    // 防重复提交：连点两次是否只产生一张单，由 disabled 状态间接判断
    currentPage = '/inventory/operations/store → 门店报货（防重复提交）'
    const disabledDuringSubmit = await submitBtn.isDisabled().catch(() => false)
    if (!disabledDuringSubmit) {
      const hasLoadingProp = await submitBtn.evaluate(
        (el) => el.hasAttribute('disabled') || el.getAttribute('aria-busy') === 'true',
      ).catch(() => false)
      if (!hasLoadingProp) {
        findings.push({
          rule: '提交按钮未在提交期间禁用',
          severity: 'P2',
          page: currentPage,
          detail: '按钮在提交过程中未见 disabled/aria-busy，快速双击存在重复建单风险（各表单内部有 saving 标志，但未反映到可访问性属性上）',
        })
      }
    }

    // ══ E. 原生弹窗汇总 ═══════════════════════════════════════════
    // INV-02/05 已实测：单据中心的建单失败走 alert()，审批/驳回/收货备注走 prompt()
    findings.push({
      rule: '使用原生 alert / prompt',
      severity: 'P1',
      page: '/inventory/docs',
      detail: '建单失败用 alert() 弹原生框（inventory-docs-page.tsx:402）；审批/驳回/收货的备注用 prompt() 收集（:135-151）。原生弹窗无法样式化、无法做必填校验（驳回原因是必填的）、移动端体验差，且会阻塞页面',
      evidence: nativeDialogs.length > 0
        ? nativeDialogs.map((d) => `${d.type}@${d.where}`).join(' / ')
        : '本轮未触发，证据见 INV-02 / INV-05',
    })

    // ══ F. 已在链路测试中确认的缺陷，一并汇入报告 ═══════════════════
    findings.push({
      rule: '批次下拉永久卡在加载中',
      severity: 'P0',
      page: '/inventory/docs → 新建库存单据',
      detail: '选定主体与 SKU 后，来源批次下拉永远停留在「加载库存批次...」且始终 disabled（实测 60s+）。根因是 inventory-docs-page.tsx:351-375 的 useEffect 自循环：依赖数组含它自己 set 的 loadingLotKeys/lotOptionsByKey，effect 重跑触发 cleanup 把 cancelled 置 true，首次请求的 then/catch/finally 全被跳过。后果：单据中心里所有需要选来源批次的单据类型（分院调货出库、市场间调货出库、内部领用、院顾客产品出库、市场产品报损、院产品报损）全部无法创建',
      evidence: '接口已返回 200，是前端把结果丢了；详见 INV-05 / inv-90-probe-lot-loading',
    })
    findings.push({
      rule: '员工下拉恒为空（SQL 别名错误）',
      severity: 'P0',
      page: '/inventory/operations/{market,supply-chain} → 员工购',
      detail: 'business.ts 有 5 处递归 CTE 写错别名引用：CTE 在 JOIN 时起了别名（JOIN descendants parent / JOIN ancestors ancestor），SELECT/WHERE 却仍用原名（descendants.path / ancestors.path），PostgreSQL 直接报 invalid reference to FROM-clause entry。后果：市场员工购与供应链员工购的员工下拉恒为空，功能完全不可用；即使绕过下拉，提交时的 employeeForMarket / employeeForSupplyChain 校验同样会炸',
      evidence: 'business.ts:1234 / 1263 / 1273 / 1329 / 1371；dev 库按正确 SQL 能查出 85 / 115 个候选',
    })
    findings.push({
      rule: '盘点单不记录账面数量',
      severity: 'P1',
      page: '/inventory/docs → 市场库存盘点 / 分院库存盘点',
      detail: 'engine.ts:2777 的 stockSnapshot 只在选中批次时才写（lot ? ... : null），而盘点单不属于 SOURCE_LOT_DOC_TYPES、UI 不提供批次选择器，于是 stock_snapshot 恒为 NULL。盘点单既不动库存也不记账面数，退化成只有「数量」的白条，无法用于任何盈亏对账',
      evidence: 'INV-06 实测 stock_snapshot = NULL',
    })
    findings.push({
      rule: 'SKU 供货商与供应商档案无关联',
      severity: 'P1',
      page: '/inventory/skus → 新建库存商品',
      detail: '「供货商」是裸 <input> 文本框，且 inventory_skus 表只有 supplier(text) 列、没有 supplier_id 外键 —— 与 inventory_suppliers 档案表（以及 /inventory/suppliers 整个页面）完全不关联。同一供应商会产生多种写法，供应商档案形同虚设，也无法按供应商统计采购',
      evidence: 'inventory-skus-page.tsx:388；information_schema 查无 supplier_id 列',
    })
    findings.push({
      rule: '业务错误提示被生产构建脱敏',
      severity: 'P1',
      page: '全局（Server Action 错误路径）',
      detail: 'Server Action 抛出的 ApiError 在生产构建下被 Next.js 统一脱敏，用户看到的是「An error occurred in the Server Components render...」或一串 error digest 数字（如 1956068727），业务文案（「库存期初尚未导入并核验完成」等）完全丢失，用户无从判断该做什么',
      evidence: 'INV-02 期初门禁拦截、INV-07 员工加载失败均复现',
    })

    // ══ 写报告 ════════════════════════════════════════════════════
    const outPath = path.resolve(__dirname, 'UX-FINDINGS.md')
    const now = new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' })
    const counts = {
      P0: findings.filter((f) => f.severity === 'P0').length,
      P1: findings.filter((f) => f.severity === 'P1').length,
      P2: findings.filter((f) => f.severity === 'P2').length,
    }
    const md = [
      '# 库存管理 —— 交互合理性审计报告',
      '',
      `> 目标：${BASE}（dev 环境 fengyu-admin）`,
      `> 生成时间：${now}`,
      `> 生成方式：\`bun run test:e2e:inventory-ui\` 中的 \`inv-10-ux-audit.spec.ts\` 自动扫描 + 链路测试中的实测发现`,
      '',
      `**共 ${findings.length} 条：P0 ${counts.P0} · P1 ${counts.P1} · P2 ${counts.P2}**`,
      '',
      '严重度口径：',
      '',
      '| 级别 | 含义 |',
      '|---|---|',
      '| P0 | 功能不可用 / 数据错误，必须修 |',
      '| P1 | 影响正确性或可理解性，用户会被误导或卡住 |',
      '| P2 | 体验与一致性问题，不阻断使用 |',
      '',
      '## 发现清单',
      '',
      renderFindings(findings),
      '## 复核说明',
      '',
      '本报告由启发式规则自动生成，**每条都需人工复核定性**为「真问题 / 设计如此 / 误报」。',
      '规则只负责摆出可核对的事实（字段名、控件类型、页面路径、源码位置），不替人下结论。',
      '',
      '其中 P0 两条与 P1 三条已在链路测试中实测复现，不是静态推测：',
      '',
      '- 批次下拉卡死 → `inv-05-transfers.spec.ts` / `inv-90-probe-lot-loading.spec.ts`',
      '- 员工下拉恒空 → `inv-07-staff-purchase-and-self-purchase.spec.ts`（并已在 dev 库直接执行原 SQL 复现报错）',
      '- 盘点不记账面数 → `inv-06-stocktake-and-loss.spec.ts`',
      '- 供货商无外键 → `inv-01-master-data.spec.ts`',
      '- 错误提示脱敏 → `inv-02-supply-chain-stock.spec.ts`',
      '',
    ].join('\n')
    fs.writeFileSync(outPath, md)
    console.log(`[INV-10] 报告已写入 ${outPath}`)
    console.log(`[INV-10] 共 ${findings.length} 条：P0 ${counts.P0} / P1 ${counts.P1} / P2 ${counts.P2}`)
    for (const f of findings.filter((x) => x.severity !== 'P2')) {
      console.log(`  [${f.severity}] ${f.rule} @ ${f.page}`)
    }
  } finally {
    await ctx.close()
  }

  expect(findings.length, 'UX 扫描应产出结果').toBeGreaterThan(0)
})
