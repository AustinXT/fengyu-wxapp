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
import { openOperation } from './_helpers/ui'
import {
  checkForeignKeyInputs, checkLabelBinding, checkListAffordances, checkNumericGuards,
  checkRequiredMarkers, checkTechnicalLeak, extractFormControls, renderFindings,
  type Finding,
} from './_helpers/ux-audit'

test.setTimeout(900_000)

/** 库存域全部列表/报表页 */
const LIST_PAGES = [
  '/inventory/stocks',
  '/inventory/movements',
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

    // ══ E. 原生弹窗汇总（实测再报，#134）═══════════════════════════
    // ⚠️ 原本是**无条件** push：#134 把 alert()/prompt() 换成 toast + 自建 Dialog 之后，
    //    报告里照旧挂一条 P1，detail 还指着早已删掉的 inventory-docs-page.tsx:402。
    //    改为只转述本轮实测 —— dialog 监听全程挂着，A/B/C/D 四段（7 个列表页 +
    //    4 个弹窗表单 + 5 张办理台表单 + 空表单提交）一次都没触发就不进表。
    //    ⚠️ 覆盖面有限：本 spec 不走单据中心的行内审批/驳回/收货，那三条原 prompt 路径
    //    由 INV-02 / INV-05 自己的 dialog 监听兜底。
    if (nativeDialogs.length > 0) {
      findings.push({
        rule: '使用原生 alert / prompt',
        severity: 'P1',
        page: Array.from(new Set(nativeDialogs.map((d) => d.where))).join(' / '),
        detail: '库存页面仍在用浏览器原生弹窗（alert / confirm / prompt）。原生弹窗无法样式化、无法做必填校验（驳回原因业务上必填）、移动端体验差，且会阻塞页面 —— 应统一换成 toast + 自建 Dialog（#134）',
        evidence: nativeDialogs.map((d) => `${d.type}@${d.where}：${d.message}`).join(' / '),
      })
    }

    // ══ F. 链路测试确认过的缺陷：一律改为转述实测判定 ═══════════════
    // ⚠️ 这两条原本是 2026-09-13 首轮实测的**硬编码**结论，不随代码状态自动失效 ——
    //    #129 / #130 的修复合入后，报告里照旧挂着两条 P0，P0 计数永远虚高，
    //    而本 spec 是**整文件覆写** UX-FINDINGS.md，手工标注「已修」下一次跑就没了。
    //    现按 #131 / #132 已建立的范式改成「转述对应 spec 自己的判定」。
    //
    // ⚠️ **三个分支一个都不能少**（照 #131 盘点那条的范式）：
    //      判定为 false          → 照旧报 P0（回归复发）
    //      判定为 true           → 不进表（实测通过）
    //      没有判定 / 判定过期   → 报 P2「未覆盖」，写明本轮没跑对应 spec
    //    第三条最容易被省掉，而省掉它的后果比 P0 虚高更糟：单跑 INV-10、或 INV-05 /
    //    INV-07 半途挂掉时，报告会静默呈现成「P0 已清零」—— 回归被当成修好了。
    //    （上一轮就踩过另一种形态：分支读的字段名压根没人写，两条 P0 成了死代码。
    //      现在读的是三条线共同约定的 ctx 契约，字段名见下方各自的注释。）
    /**
     * ctx 文件跨运行保留，**两个方向都要判时效**：
     *   - 上一轮「合格」+ 之后回退 → 单跑 INV-10 会零输出，回归漏报；
     *   - 上一轮「不合格」+ 之后修好 → 单跑 INV-10 会继续断言有问题，误报。
     * 口径与 #131 / #132 一致：6 小时。
     */
    const staleEvidence = (at?: string): boolean => {
      const age = at ? Date.now() - Date.parse(at) : NaN
      return !Number.isFinite(age) || age < 0 || age > 6 * 3600_000
    }

    // 批次下拉卡死（issue #129，已于 2026-09-21 关闭）：转述 INV-05 的守护判定。
    // ctx 契约（D/E/F 三条线共用，字段名不可各写各的）：
    //   inv05 = { at, lotLoadingOk: boolean, genericDocsCreated: string[] }
    //     lotLoadingOk       —— 单据中心批次下拉是否在 30s 内解禁并出现真实批次
    //     genericDocsCreated —— 本轮真正建出来的通用单据号（下拉不可用就一张也建不出来，
    //                           所以它是 lotLoadingOk 的旁证，一并写进 evidence 供人工复核）
    const inv05 = readCtx<{
      lotLoadingOk?: boolean
      genericDocsCreated?: string[]
      at?: string
    }>('inv05')
    const lotDocs = inv05?.genericDocsCreated
    const lotEvidence = `INV-05 判定 lotLoadingOk=${String(inv05?.lotLoadingOk)}，本轮建出通用单据 ${lotDocs?.length ? lotDocs.join(' / ') : '(无)'}，写于 ${inv05?.at ?? '(缺失)'}`
    if (inv05?.lotLoadingOk === undefined) {
      findings.push({
        rule: '批次下拉状态未覆盖（本轮未跑 INV-05 或判定未执行）',
        severity: 'P2',
        page: '/inventory/docs → 新建库存单据（来源批次）',
        detail: '本轮没有 INV-05 的 #129 守护判定可转述（它没跑、或建单前就挂了导致判定压根没执行），因此**无法判定 #129 是否回归**。单跑 INV-10 时属正常 —— 这既不等于缺陷复现，也不等于已复核通过，别把它读成「P0 已清零」',
        evidence: inv05?.at ? `ctx inv05 写于 ${inv05.at}，无 lotLoadingOk` : 'ctx 无 inv05',
      })
    } else if (staleEvidence(inv05.at)) {
      findings.push({
        rule: '批次下拉状态证据过期未复核',
        severity: 'P2',
        page: '/inventory/docs → 新建库存单据（来源批次）',
        detail: '上下文里有 INV-05 的 #129 守护判定，但那次运行距今已超过 6 小时（或时间戳异常）。这期间本实例可能已重新部署，该判定既不能证明当前实现正确、也不能证明它有问题 —— 请跑一遍 INV-05 再看',
        evidence: lotEvidence,
      })
    } else if (inv05.lotLoadingOk === false) {
      findings.push({
        rule: '批次下拉永久卡在加载中',
        severity: 'P0',
        page: '/inventory/docs → 新建库存单据（来源批次）',
        detail: 'INV-05 实测：选定出库/入库主体与 SKU 后，来源批次下拉在超时窗口内仍未解禁、或解禁后没有任何真实批次。#129 的根因是 useEffect 依赖数组含它自己 set 的 state 形成自循环，cleanup 把首次请求的 then/catch/finally 全跳过。后果：单据中心里所有需选来源批次的单据类型（分院调货出库、市场间调货出库、内部领用、院顾客产品出库、市场产品报损、院产品报损）全部无法创建',
        evidence: lotEvidence,
      })
    }
    // lotLoadingOk === true → 本轮实测通过，**不进表**

    // 员工下拉恒为空（issue #130，已于 2026-09-21 关闭）：转述 INV-07 的候选数。
    // 不删除本条 —— 删了就没人在报告里对回归发声；改成实测再报后它自动跟随代码状态。
    // ctx 契约：inv07 = { at, employeeOptionsOk: boolean, marketStaffCount: number, supplyStaffCount: number }
    //   employeeOptionsOk —— 两个员工购下拉是否都有候选（判定以它为准）
    //   *StaffCount       —— **候选人数**（不含占位项；dev 实测 市场 115 / 供应链 10），
    //                        仅作 evidence；⚠️ 与旧版「option 总数 <= 1」的口径不同，别混用
    const inv07 = readCtx<{
      employeeOptionsOk?: boolean
      marketStaffCount?: number
      supplyStaffCount?: number
      at?: string
    }>('inv07')
    const marketStaffCount = inv07?.marketStaffCount
    const supplyStaffCount = inv07?.supplyStaffCount
    // 布尔缺失但两个计数都写了时按「都至少有一个候选」兜底推导；两者都没有才算未覆盖。
    const employeeOptionsOk = inv07?.employeeOptionsOk
      ?? (marketStaffCount !== undefined && supplyStaffCount !== undefined
        ? marketStaffCount > 0 && supplyStaffCount > 0
        : undefined)
    const staffEvidence = `INV-07 判定 employeeOptionsOk=${String(inv07?.employeeOptionsOk)} / 市场员工购候选=${marketStaffCount ?? '(未判定)'} / 供应链员工购候选=${supplyStaffCount ?? '(未判定)'}，写于 ${inv07?.at ?? '(缺失)'}`
    if (employeeOptionsOk === undefined) {
      findings.push({
        rule: '员工下拉候选未覆盖（本轮未跑 INV-07 或判定未执行）',
        severity: 'P2',
        page: '/inventory/operations/{market,supply-chain} → 员工购',
        detail: '本轮没有 INV-07 的员工下拉判定可转述（它没跑、或打开办理台前就挂了），因此**无法判定 #130 是否回归**。单跑 INV-10 时属正常 —— 这既不等于缺陷复现，也不等于已复核通过',
        evidence: inv07?.at ? `ctx inv07 写于 ${inv07.at}，无 employeeOptionsOk / *StaffCount` : 'ctx 无 inv07',
      })
    } else if (staleEvidence(inv07?.at)) {
      findings.push({
        rule: '员工下拉候选证据过期未复核',
        severity: 'P2',
        page: '/inventory/operations/{market,supply-chain} → 员工购',
        detail: '上下文里有 INV-07 的员工下拉判定，但那次运行距今已超过 6 小时（或时间戳异常）。这期间本实例可能已重新部署 —— 请跑一遍 INV-07 再看',
        evidence: staffEvidence,
      })
    } else if (employeeOptionsOk === false) {
      findings.push({
        rule: '员工下拉恒为空（SQL 别名错误）',
        severity: 'P0',
        page: '/inventory/operations/{market,supply-chain} → 员工购',
        detail: 'INV-07 实测：员工购的员工下拉在占位项之外没有任何候选。#130 的根因是 business.ts 的递归 CTE 写错别名引用（CTE 在 JOIN 时起了别名，SELECT/WHERE 仍用原名），PostgreSQL 直接报 invalid reference to FROM-clause entry。后果：市场员工购与供应链员工购完全不可用；即使绕过下拉，提交时的 employeeForMarket / employeeForSupplyChain 校验同样会炸',
        evidence: staffEvidence,
      })
    }
    // employeeOptionsOk === true → 本轮实测通过，**不进表**

    // 盘点账面数（issue #131）：只看 **INV-06 本轮受控创建**的盘点单（单号经 ctx 传来）。
    //   - 无条件登记   → 修好之后报告仍输出旧结论，本身就是假情报
    //   - 扫全库历史   → dev 上有 8 张 #131 修复前建的单，stock_snapshot 本来就是 NULL；
    //                    不论报 P1 还是 P2，都是把「甲方已接受的历史数据」当缺陷
    //   - 只看最近一张 → 修复已部署但还没人建新单时误报；只看第一行还会漏掉第二行的回归
    // 受控单据是唯一能证明「当前实现是否把账面数写进去」的样本。
    // 盘点账面数（issue #131）：**转述 INV-06 自己的判定**，不在这里重新查库反推。
    //
    // 为什么不自己查：ctx 文件跨运行保留，回退后单跑 INV-10 会读到回退前建的非空单据
    // 而漏报；扫全库历史又会把 dev 上 8 张修复前的 NULL 单当成缺陷。两条路都通不了 ——
    // 「当前部署有没有生效」只有**跑过建单的那支 spec** 才知道。
    // 时间戳只用来标明证据时效，不当「同一轮」的证明（这一点本报告不假装能证明）。
    const inv06 = readCtx<{
      snapshotPresent?: boolean | null
      snapshotMatchesBook?: boolean | null
      mpdId?: string
      at?: string
    }>('inv06')
    // ⚠️ **两个方向都要判时效**，ctx 文件跨运行保留：
    //    - 上一轮的「合格」+ 之后回退 → 单跑 INV-10 会零输出，回归漏报；
    //    - 上一轮的「不合格」+ 之后修好 → 单跑 INV-10 会继续断言「当前未生效」，误报。
    //    本报告**不假装能证明部署状态**（那需要同轮 run-id 或部署指纹），
    //    只把「证据太旧、没复核过」如实摆出来。
    const evidenceAge = inv06?.at ? Date.now() - Date.parse(inv06.at) : NaN
    const evidenceStale = !Number.isFinite(evidenceAge) || evidenceAge < 0 || evidenceAge > 6 * 3600_000
    const evidenceAt = inv06?.at ? `（证据来自 INV-06 ${inv06.at} 的运行）` : ''
    const present = inv06?.snapshotPresent ?? null
    const matches = inv06?.snapshotMatchesBook ?? null

    if (present === false && !evidenceStale) {
      // 真·没写：退化成白条。**优先于其它分支** —— 这条与并发无关，
      // 即便口径判定因并发被降级成 null，也不该把已确认的「没写」说成「不知道」。
      findings.push({
        rule: '盘点单不记录账面数量',
        severity: 'P1',
        page: '/inventory/docs → 市场库存盘点 / 分院库存盘点',
        detail: `INV-06 实测新建的盘点单没有写 stock_snapshot —— 盘点单既不动库存也不记账面数，退化成只有「数量」的白条，无法用于任何盈亏对账。issue #131 的修复是「无批次时按主体 + SKU 汇总在手量写入」，这条出现说明该实例上修复未生效${evidenceAt}`,
        evidence: `INV-06 判定 snapshotPresent=false，受控单据 ${inv06?.mpdId ?? '(无单号)'}`,
      })
    } else if (present === null) {
      findings.push({
        rule: '盘点账面数量未覆盖（本轮未跑 INV-06 或判定未执行）',
        severity: 'P2',
        page: '/inventory/docs → 市场库存盘点 / 分院库存盘点',
        detail: '没有 INV-06 的判定可转述（它没跑、或建单失败导致判定压根没执行），无法判定 stock_snapshot 是否落库。单跑 INV-10 时属正常 —— 注意这**不等于** #131 回归，别当成缺陷',
        evidence: inv06?.at ? `ctx inv06 写于 ${inv06.at}，snapshotPresent=null` : 'ctx 无 inv06',
      })
    } else if (evidenceStale) {
      findings.push({
        rule: '盘点账面数量证据过期未复核',
        severity: 'P2',
        page: '/inventory/docs → 市场库存盘点 / 分院库存盘点',
        detail: `上下文里有 INV-06 的判定（写入=${String(present)} / 口径=${String(matches)}），但那次运行距今已超过 6 小时（或时间戳异常）。这期间本实例可能已重新部署，该判定既不能证明当前实现正确、也不能证明它有问题 —— 请跑一遍 INV-06 再看`,
        evidence: `ctx inv06 写于 ${inv06?.at ?? '(缺失)'}`,
      })
    } else if (matches === false) {
      // 写了、但值不对 —— 与「没写」是两回事，报告不能说成「退化成白条」
      findings.push({
        rule: '盘点账面数量口径不符',
        severity: 'P1',
        page: '/inventory/docs → 市场库存盘点 / 分院库存盘点',
        detail: `盘点单**写了** stock_snapshot，但数值不等于「该主体下该 SKU 全部批次在手量之和」（#131 Q0 在手量不扣预留 / Q1 按 SKU 汇总）。差异列会据此算出错误的盘盈盘亏${evidenceAt}`,
        evidence: `INV-06 判定 snapshotPresent=true 但 snapshotMatchesBook=false，受控单据 ${inv06?.mpdId ?? '(无单号)'}`,
      })
    } else if (matches === null) {
      findings.push({
        rule: '盘点账面数量口径未复核（撞上并发）',
        severity: 'P2',
        page: '/inventory/docs → 市场库存盘点 / 分院库存盘点',
        detail: '账面数已写入，但核对期间该 SKU 在手量被他人改动，INV-06 把口径判定降级了 —— 本轮无法判断数值是否正确。重跑 INV-06 即可',
        evidence: `INV-06 判定 snapshotPresent=true，snapshotMatchesBook=null（并发降级）`,
      })
    }
    // SKU 供货商关联档案（issue #132）：**转述 INV-01 自己的判定**，不在这里硬编码字面量。
    // 硬编码的那条即便修好也会原样复活 —— 本 spec 是**整文件覆写** UX-FINDINGS.md，
    // 手工加的「已修」标注下一次跑就没了，P1 计数永远虚高。
    // 时效判定与 #131 的盘点那条同口径：ctx 跨运行保留，两个方向都要防。
    const inv01 = readCtx<{
      supplierControlTag?: string
      supplierFkPresent?: boolean
      skuSupplierLinked?: boolean
      at?: string
    }>('inv01')
    const supplierEvidenceAge = inv01?.at ? Date.now() - Date.parse(inv01.at) : NaN
    const supplierEvidenceStale = !Number.isFinite(supplierEvidenceAge)
      || supplierEvidenceAge < 0
      || supplierEvidenceAge > 6 * 3600_000
    const supplierJudged = inv01?.supplierControlTag !== undefined
    const supplierBroken = supplierJudged && (
      inv01!.supplierControlTag !== 'select'
      || inv01!.supplierFkPresent !== true
      || inv01!.skuSupplierLinked !== true
    )

    if (supplierBroken && !supplierEvidenceStale) {
      findings.push({
        rule: 'SKU 供货商与供应商档案无关联',
        severity: 'P1',
        page: '/inventory/skus → 新建库存商品',
        detail: `INV-01 实测：供货商控件=${inv01!.supplierControlTag}、inventory_skus.supplier_id 外键存在=${String(inv01!.supplierFkPresent)}、新建 SKU 落库后 supplier_id 指向所选档案=${String(inv01!.skuSupplierLinked)}。三项有一项不成立，就说明该实例上 issue #132 的修复未生效 —— 供货商回到自由文本会让同一供应商产生多种写法，档案形同虚设，也无法按供应商统计采购（证据来自 INV-01 ${inv01!.at} 的运行）`,
        evidence: `INV-01 判定 控件=${inv01!.supplierControlTag} / 外键=${String(inv01!.supplierFkPresent)} / 关联=${String(inv01!.skuSupplierLinked)}`,
      })
    } else if (!supplierJudged) {
      findings.push({
        rule: 'SKU 供货商关联未覆盖（本轮未跑 INV-01 或判定未执行）',
        severity: 'P2',
        page: '/inventory/skus → 新建库存商品',
        detail: '没有 INV-01 的判定可转述（它没跑、或建档失败导致判定压根没执行）。单跑 INV-10 时属正常 —— 这**不等于** #132 回归，别当成缺陷',
        evidence: inv01?.at ? `ctx inv01 写于 ${inv01.at}，无 supplierControlTag` : 'ctx 无 inv01',
      })
    } else if (supplierEvidenceStale) {
      findings.push({
        rule: 'SKU 供货商关联证据过期未复核',
        severity: 'P2',
        page: '/inventory/skus → 新建库存商品',
        detail: `上下文里有 INV-01 的判定（控件=${inv01!.supplierControlTag} / 外键=${String(inv01!.supplierFkPresent)}），但那次运行距今已超过 6 小时（或时间戳异常）。这期间本实例可能已重新部署，该判定既不能证明当前实现正确、也不能证明它有问题 —— 请跑一遍 INV-01 再看`,
        evidence: `ctx inv01 写于 ${inv01?.at ?? '(缺失)'}`,
      })
    }
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
      '下列条目**若出现在上表中**，其证据来自实测复现，不是静态推测：',
      '',
      '- 批次下拉卡死 → `inv-05-transfers.spec.ts` 写入上下文的 `lotLoadingOk`（#129 已修；需细看采样过程时用 `inv-90-probe-lot-loading.spec.ts`）',
      '- 员工下拉恒空 → `inv-07-staff-purchase-and-self-purchase.spec.ts` 写入上下文的 `employeeOptionsOk` + 两个候选数（#130 已修）',
      '- 原生 alert / prompt → 本 spec 全程挂着的 dialog 监听计数（#134 已修）',
      '- 盘点不记账面数 → `inv-06-stocktake-and-loss.spec.ts`',
      '- 供货商无外键 → `inv-01-master-data.spec.ts`（#132 已修）',
      '- 错误提示脱敏 → `inv-02-supply-chain-stock.spec.ts`',
      '',
      '（以上条目一律**实测再报**：本轮实测通过就不会出现在上表里。',
      '这几行只说明**万一出现**时证据来自哪支 spec，不代表它已复现。',
      '反过来，**上表里带「未覆盖」「证据过期」字样的 P2 也不是缺陷** —— 它们的含义是',
      '「本轮没有可转述的实测判定，该 issue 是否回归无从判断」。看到它们请补跑对应 spec，',
      '别把「没有 P0」读成「P0 已清零」。）',
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
