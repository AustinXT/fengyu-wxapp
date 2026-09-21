/**
 * e2e-inventory-ui/_helpers/ui.ts
 *
 * 库存 UI 的通用定位与操作原语。全部在 INV-01~03 的实跑中验证过，
 * 每条经验都对应一个踩过的坑（见各函数注释）。
 */

import { expect, type Locator, type Page } from '@playwright/test'
import { BASE, psql, sqlStr } from './env'

export function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/**
 * 按 label 文本定位表单字段容器。
 *
 * 库存各表单统一用 `<label><span>字段名</span><控件/></label>` 的隐式关联写法
 * （FormField / Field 组件）。注意不能用 getByLabel：
 *   1) 部分 label 里塞了整段说明文字（如「市场进货价…公式价 = 核算价 × 市场折扣」），
 *      substring 匹配会命中多个元素触发 strict mode violation；
 *   2) 少数表单（供应商）的 <label> 根本没包裹控件，getByLabel 直接找不到。
 */
export function labelled(page: Page, labelText: string): Locator {
  return page.locator('label').filter({ hasText: new RegExp(`^${escapeRe(labelText)}`) })
}

export async function fillByLabel(page: Page, labelText: string, value: string): Promise<void> {
  await labelled(page, labelText).locator('input, textarea').first().fill(value)
}

/**
 * 选中「option 文本包含 text」的那一项。
 *
 * selectOption 的 label 只接受**精确字符串**，传正则会报
 * "options[0].label: expected string, got object"。而单据/SKU 的 option 文本是拼出来的
 * （「CGD-20260913-0005 · 2026-09-13 · 品牌总部」），只能按包含匹配。
 */
export async function selectContaining(sel: Locator, text: string): Promise<void> {
  const value = await sel.locator('option').filter({ hasText: text }).first().getAttribute('value')
  if (value === null) {
    throw new Error(`未找到含「${text}」的选项。现有: ${JSON.stringify(await sel.locator('option').allTextContents())}`)
  }
  await sel.selectOption(value)
}

/**
 * 选中某个 label 下的下拉项；字段已被固定成只读时改为核对展示值。
 *
 * 候选唯一的库存主体（总部只有一个根节点、市场/门店角色只管一个主体）会自动选中
 * 并降级成只读 `<output data-fixed-subject>`（#189）—— 那里根本没有 select 可选，
 * 硬等 `toBeEnabled` 只会超时。此时断言展示的就是期望的主体，语义与"选中它"等价。
 */
export async function selectByLabel(
  page: Page,
  labelText: string,
  option: { label: string } | { contains: string },
): Promise<void> {
  const field = labelled(page, labelText)
  await expect(field.locator('select, [data-fixed-subject]').first()).toBeVisible({ timeout: 20_000 })
  const fixed = field.locator('[data-fixed-subject]')
  if (await fixed.count() > 0) {
    await expect(fixed.first()).toContainText('contains' in option ? option.contains : option.label)
    return
  }
  const sel = field.locator('select').first()
  await expect(sel).toBeEnabled({ timeout: 20_000 })
  if ('contains' in option) await selectContaining(sel, option.contains)
  else await sel.selectOption({ label: option.label })
}

/** 明细行里的 SkuPicker（占位文案「选择库存商品」） */
/**
 * 勾选合并后采购表单里的来源报货单（#194）。
 *
 * 来源从单选 Select 改成了多选 checkbox 清单，一次可以勾多张；勾完组件会重新拉明细，
 * 所以调用方勾完要等明细渲染出来再填数量。
 */
export async function checkSourceDoc(page: Page, docId: string): Promise<void> {
  const row = page.locator('label').filter({ hasText: docId }).first()
  await row.waitFor({ state: 'visible', timeout: 15_000 })
  await row.locator('input[type="checkbox"]').check()
}

export function skuSelect(page: Page, index = 0): Locator {
  return page.locator('select').filter({ hasText: '选择库存商品' }).nth(index)
}

/**
 * 打开某层办理台的某张操作卡片。
 *
 * 卡片按钮不能用 exact 匹配：需要额外权限的卡片会在标题下渲染一枚徽章
 * （「审批权限」「撤回申请权限」「自采入库权限」），使按钮的 accessible name
 * 变成「审批门店退货 审批权限」，exact:true 直接匹配不到。
 */
export async function openOperation(page: Page, level: string, title: string): Promise<void> {
  await page.goto(`${BASE}/inventory/operations/${level}`)
  await page.waitForLoadState('networkidle')
  await page.locator('main').getByRole('button', { name: title }).first().click()
  await expect(page.getByRole('heading', { name: title })).toBeVisible({ timeout: 20_000 })
}

/**
 * 点击表单提交按钮并读取结果 toast。
 *
 * 两个坑：
 *   1) 必须限定在 <form> 内 —— 办理台的操作卡片也是 <button>，个别与提交按钮同名
 *      （「创建采购订单」既是卡片标题又是提交按钮），否则 strict mode violation。
 *   2) 不能只 expect(getByText(/已创建/))：失败时 toast 是错误文案，等到超时后
 *      toast 早已消失，截图里什么都看不到。改为主动读 [data-sonner-toast] 的文本，
 *      失败时把真实错误抛出来（这才定位到了「库存不足：… 可用 10」这类问题）。
 */
export async function submitForm(page: Page, name: string, expectText: RegExp): Promise<string> {
  await page.locator('form').getByRole('button', { name, exact: true }).click()
  return await readToast(page, name, expectText)
}

/** 同 submitForm，但按钮不在 <form> 内（如退货审批区是个 <div>） */
export async function clickAndExpectToast(page: Page, name: string, expectText: RegExp): Promise<string> {
  await page.getByRole('button', { name, exact: true }).last().click()
  return await readToast(page, name, expectText)
}

async function readToast(page: Page, name: string, expectText: RegExp): Promise<string> {
  const toast = page.locator('[data-sonner-toast]').first()
  await toast.waitFor({ state: 'visible', timeout: 30_000 }).catch(() => null)
  const text = (await toast.innerText().catch(() => '')) || '(未出现任何 toast)'
  if (!expectText.test(text)) {
    throw new Error(`操作「${name}」未得到预期结果。实际提示：${text.replace(/\n/g, ' ')}`)
  }
  return text
}

/** 读取当前可见的 toast 文本（不做断言），用于期望失败的场景 */
export async function peekToast(page: Page, timeout = 20_000): Promise<string> {
  const toast = page.locator('[data-sonner-toast]').first()
  await toast.waitFor({ state: 'visible', timeout }).catch(() => null)
  return ((await toast.innerText().catch(() => '')) || '').replace(/\n/g, ' ')
}

/**
 * 选中一个可用量 >= minQty 的批次，返回该批次可用量。
 *
 * 不能取 index=1：同一主体常有多个批次，第一个未必够用
 * （实跑撞过「库存不足：… 可用 10」）。option 文案形如「批次 XXX · 可用 35」。
 */
export async function selectLotWithQty(page: Page, labelText: string, minQty: number): Promise<number> {
  const sel = labelled(page, labelText).locator('select').first()
  await expect(sel).toBeEnabled({ timeout: 20_000 })
  const texts = await sel.locator('option').allTextContents()
  for (let i = 1; i < texts.length; i += 1) {
    const available = Number(texts[i].match(/可用\s*([\d.]+)/)?.[1] ?? '0')
    if (available >= minQty) {
      await sel.selectOption({ index: i })
      return available
    }
  }
  throw new Error(`「${labelText}」没有可用量 >= ${minQty} 的批次。现有: ${JSON.stringify(texts)}`)
}

/** 按批号文本精确选中批次 */
export async function selectLotContaining(page: Page, labelText: string, batchNo: string): Promise<void> {
  const sel = labelled(page, labelText).locator('select').first()
  await expect(sel).toBeEnabled({ timeout: 20_000 })
  await selectContaining(sel, batchNo)
}

/** 批次下拉里可用量不足 minQty 的可选项数量 —— UX 观察用 */
export async function countInsufficientLots(page: Page, labelText: string, minQty: number): Promise<number> {
  const texts = await labelled(page, labelText).locator('select').first().locator('option').allTextContents()
  return texts.slice(1).filter((t) => Number(t.match(/可用\s*([\d.]+)/)?.[1] ?? '0') < minQty).length
}

// ─────────────────── 单据中心：通用建单与行内操作 ───────────────────

export interface GenericDocInput {
  docType: string
  /** 出库/发起主体的 option 文本片段，如「市场 · 南昌凤御」 */
  sourceLabel?: string
  /** 入库/接收主体 */
  targetLabel?: string
  skuName: string
  quantity: number
  remark: string
  /** 出库类单据需要先选来源批次；可用量不足时会在提交阶段报错 */
  needLot?: boolean
  batchNo?: string
}

/**
 * 走 /inventory/docs 的通用建单弹窗建一张单，返回操作结果。
 *
 * 只有 INVENTORY_GENERIC_DOC_TYPES 这 10 种能从这里建（分院调货出库/市场间调货出库/
 * 内部领用/院顾客产品出库/院顾客退货/市场产品报损/院产品报损/市场产品盘溢/
 * 市场库存盘点/分院库存盘点）。其余类型必须走对应的专用办理台。
 *
 * ⚠️ 这个弹窗提交失败走的是原生 alert()（inventory-docs-page.tsx:402），
 * 调用方必须提前挂好 page.on('dialog')，否则弹窗会阻塞整个页面。
 */
export async function createGenericDoc(
  page: Page,
  input: GenericDocInput,
): Promise<void> {
  await page.goto(`${BASE}/inventory/docs`)
  await page.waitForLoadState('networkidle')
  await page.getByRole('button', { name: /新建/ }).first().click()
  const dialog = page.getByRole('dialog')
  await expect(dialog.getByText('新建库存单据')).toBeVisible({ timeout: 15_000 })

  const selects = dialog.locator('select')
  await selects.nth(0).selectOption(input.docType)
  if (input.sourceLabel) await selectContaining(selects.nth(1), input.sourceLabel)
  if (input.targetLabel) await selectContaining(selects.nth(2), input.targetLabel)
  await dialog.locator('textarea').first().fill(input.remark)

  // 明细行的下拉按**位置**定位，不能按占位文案 filter：
  // 批次框的占位文案是「先选择库存 SKU」，**包含**「库存 SKU」，
  // 用 filter({hasText:'库存 SKU'}).first() 会拿到批次框而不是 SKU 框。
  // 弹窗内 select 的固定顺序：0=单据类型 1=出库主体 2=入库主体 [3=批次] 3或4=SKU
  await page.waitForTimeout(500)   // 等选完类型后明细行重新渲染
  const skuSel = selects.nth(input.needLot ? 4 : 3)
  await selectContaining(skuSel, input.skuName)

  if (input.needLot) {
    // 批次框依赖「已选出库主体 + 已选 SKU」才解除 disabled，故必须排在选 SKU 之后
    const lotSel = selects.nth(3)
    await expect(lotSel).toBeEnabled({ timeout: 20_000 })
    if (input.batchNo) await selectContaining(lotSel, input.batchNo)
    else await selectLotOptionWithQty(lotSel, input.quantity)
  }

  await dialog.getByPlaceholder('数量').fill(String(input.quantity))
  if (input.batchNo && !input.needLot) {
    await dialog.getByPlaceholder('批号').fill(input.batchNo)
  }
  await dialog.getByRole('button', { name: '提交' }).click()
  await page.waitForTimeout(3500)
  await page.keyboard.press('Escape').catch(() => null)
}

async function selectLotOptionWithQty(sel: Locator, minQty: number): Promise<void> {
  const texts = await sel.locator('option').allTextContents()
  for (let i = 1; i < texts.length; i += 1) {
    if (Number(texts[i].match(/可用\s*([\d.]+)/)?.[1] ?? '0') >= minQty) {
      await sel.selectOption({ index: i })
      return
    }
  }
  throw new Error(`通用建单：无可用量 >= ${minQty} 的批次。现有: ${JSON.stringify(texts)}`)
}

/**
 * 在单据中心对某单据执行行内操作（通过 / 驳回 / 收货）。
 *
 * ⚠️ 这三个操作的备注都用原生 prompt() 收集（inventory-docs-page.tsx:135-151），
 * 调用方必须挂 page.on('dialog') 并用 accept(备注文本) 应答，否则会卡死。
 */
export async function rowAction(page: Page, docId: string, action: '通过' | '驳回' | '收货'): Promise<void> {
  await page.goto(`${BASE}/inventory/docs?q=${encodeURIComponent(docId)}`)
  await page.waitForLoadState('networkidle')
  await page.waitForTimeout(1200)
  const row = page.locator('tbody tr').filter({ hasText: docId }).first()
  await expect(row).toBeVisible({ timeout: 15_000 })
  await row.getByRole('button', { name: action }).click()
  await page.waitForTimeout(3500)
}

// ───────────────────────── DB 读取断言 ─────────────────────────

export function docIdByRemark(docType: string, remark: string): string {
  return psql(
    `SELECT id FROM inventory_docs WHERE doc_type = ${sqlStr(docType)} AND remark = ${sqlStr(remark)} LIMIT 1`,
  )
}

export function docStatus(docId: string): string {
  return psql(`SELECT status FROM inventory_docs WHERE id = ${sqlStr(docId)}`)
}

export function docMovementCount(docId: string): number {
  return Number(psql(`SELECT count(*) FROM inventory_movements WHERE doc_id = ${sqlStr(docId)}`))
}

/** 指定主体 + SKU + 批号的在手数量 */
export function lotQty(orgNodeId: string, skuId: string, batchNo: string): number {
  return Number(psql(
    `SELECT COALESCE(SUM(l.quantity_on_hand),0)::text FROM inventory_stock_lots l
       JOIN inventory_locations loc ON loc.location_id = l.location_id
      WHERE loc.org_node_id = ${sqlStr(orgNodeId)} AND l.sku_id = ${sqlStr(skuId)}
        AND l.batch_no = ${sqlStr(batchNo)}`,
  ))
}

/** 指定主体 + SKU 的全部批次在手合计 */
/**
 * 指定 org 节点 + SKU 的全部批次在手数量之和。
 *
 * ⚠️ 这里按 `org_node_id` JOIN 求和，而引擎按 `location_id` 直查。两者相等的前提是
 * **一个 org 节点恰好对应一个 `inventory_locations` 行** —— 由 `uq_inventory_locations_org`
 * 唯一索引保证（db/schema/inventory.ts）。将来若出现一 org 多 location 的拓扑，
 * 这里会静默变成口径漂移，届时要改成按 location 聚合。
 */
export function lotQtyAll(orgNodeId: string, skuId: string): number {
  return Number(psql(
    `SELECT COALESCE(SUM(l.quantity_on_hand),0)::text FROM inventory_stock_lots l
       JOIN inventory_locations loc ON loc.location_id = l.location_id
      WHERE loc.org_node_id = ${sqlStr(orgNodeId)} AND l.sku_id = ${sqlStr(skuId)}`,
  ))
}

/** 某单据的预留状态分布，形如 "已预留:2|已完成:1" */
export function reservationStates(docId: string): string {
  return psql(
    `SELECT COALESCE(string_agg(status || ':' || cnt::text, '|' ORDER BY status), '')
       FROM (SELECT status, count(*) AS cnt FROM inventory_stock_reservations
              WHERE request_doc_id = ${sqlStr(docId)} GROUP BY status) t`,
  )
}
