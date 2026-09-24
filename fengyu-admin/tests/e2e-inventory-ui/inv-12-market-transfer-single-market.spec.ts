/**
 * INV-12：只管一个市场的账号发起市场间调货（#340）。
 *
 * 缺陷形态：建单弹窗「入库/接收主体」原先与发起端共用 `listInventoryLocations()`（按 scope
 * 过滤），「市场库存财务」（INVT-MK-01，只绑南昌凤御）的下拉里没有任何其他市场，流程在
 * 第一步就走不下去。INV-05 用 ADM（scope 不受限）驱动，测不出来。
 *
 * 本 spec 覆盖：
 *   1  MK 打开单据中心建单，选「市场间调货出库」：发起端只读固定为本市场；
 *      接收端列出他市场（自贡凤御），且**不含**本市场
 *   2  MK 以他市场为接收主体提交成功 → MTO 待收货，南昌凤御在手量 −N
 *   3  调出方 MK 的市场办理台「市场间调货」卡：这张单在「本业务产出」里，**不在**「待我处理」
 *   4  调入方 MK2（只绑自贡凤御的市场库存财务）在同一张卡的「待我处理」里确认收货
 *      （用户 2026-09-24 拍板 inbox=A）→ MTI 生成、自贡凤御在手量 +N
 *
 * ⚠️ 破坏性：与 INV-05 第 4 段同样，会把 `QTY` 件供应链品**永久**搬进自贡凤御
 *    （inventory_movements append-only）。README 已声明本套件直连 dev 共享库且不清理。
 *
 * 前置：inv-00 → inv-05 已按顺序跑过（inv-01 建 SKU、inv-02/03 把货配到南昌凤御）。
 *    南昌凤御没有可用量 >= QTY 的批次时本 spec 直接报前置失败，别去怀疑 #340 的改动。
 *
 * 单跑：
 *   ADMIN_BASE_URL=http://localhost:3013 bunx playwright test \
 *     --config=tests/e2e-inventory-ui/playwright.inventory.config.ts \
 *     tests/e2e-inventory-ui/inv-12-*.spec.ts
 */

import { test, expect, type Page } from '@playwright/test'
import { BASE, INVT_ACCOUNTS, INVT_PASS, NS, TOPO, login, psql, readCtx } from './_helpers/env'
import { isGateOpen, openCutoverGate } from './_helpers/cutover'
import { docIdByRemark, docStatus, lotQtyAll, openOperation, peekToast, selectContaining } from './_helpers/ui'

test.setTimeout(300_000)

const STAMP = Date.now().toString().slice(-8)
const REMARK = `${NS}-单市场发起调货-${STAMP}`
const QTY = 1

/** 打开市场办理台「市场间调货」卡的「单据」Tab，返回两段的定位器 */
async function openMarketTransferDocsTab(page: Page) {
  await openOperation(page, 'market', '市场间调货')
  await page.getByRole('tab', { name: /^单据/ }).click()
  const inbox = page.getByRole('region', { name: '待我处理' })
  const produced = page.getByRole('region', { name: '本业务产出' })
  await expect(produced).toBeVisible({ timeout: 20_000 })
  await expect(inbox).toBeVisible({ timeout: 20_000 })
  return { inbox, produced }
}

async function openCreateDialog(page: Page) {
  await page.goto(`${BASE}/inventory/docs`)
  await page.waitForLoadState('networkidle')
  await page.getByRole('button', { name: /新建/ }).first().click()
  const dialog = page.getByRole('dialog').filter({ hasText: '新建库存单据' })
  await expect(dialog.getByText('新建库存单据')).toBeVisible({ timeout: 15_000 })
  return dialog
}

test('INV-12：市场库存财务（单市场）发起市场间调货，调入方收货后两端在手量正确（#340）', async ({ page }) => {
  const inv01 = readCtx<{ supplySkuId: string; supplySkuName: string }>('inv01')
  if (!inv01?.supplySkuId) {
    throw new Error('缺少 INV-01 上下文（supplySkuId），请按 inv-00 → inv-05 的顺序整套跑')
  }
  if (!isGateOpen()) openCutoverGate()
  expect(INVT_ACCOUNTS.MK.scopeId, 'MK 账号应只绑南昌凤御').toBe(TOPO.MARKET)
  expect(
    lotQtyAll(TOPO.MARKET, inv01.supplySkuId),
    `前置：${TOPO.MARKET_NAME} 供应链品在手量需 >= ${QTY}`,
  ).toBeGreaterThanOrEqual(QTY)

  // 启用市场 <= 2 时，排除调出市场后接收端只剩唯一候选、会降级成只读 output，
  // 下面按 select 定位的步骤会找不到控件 —— 那是数据形态变了，不是 #340 回归。
  const activeMarkets = Number(psql(
    `SELECT count(*) FROM inventory_locations WHERE location_type = '市场' AND is_active AND org_node_id IS NOT NULL`,
  ))
  expect(activeMarkets, '前置：启用市场需 >= 3，接收端才是可选下拉').toBeGreaterThanOrEqual(3)

  const srcBefore = lotQtyAll(TOPO.MARKET, inv01.supplySkuId)
  const dstBefore = lotQtyAll(TOPO.MARKET_OTHER, inv01.supplySkuId)

  // ══ 1. MK 建单：接收端能选到他市场，且不含自己 ═══════════════════════
  await login(page, INVT_ACCOUNTS.MK.phone, INVT_PASS)
  const dialog = await openCreateDialog(page)
  await dialog.locator('select').first().selectOption('市场间调货出库')

  // 发起端：scope 里只有南昌凤御一个市场（门店不进市场间调货的发起候选）→ 只读固定
  const source = dialog.locator('label').filter({ hasText: /^出库\/发起主体/ }).first()
  await expect(source.locator('[data-fixed-subject]')).toHaveAttribute('data-fixed-subject', TOPO.MARKET, {
    timeout: 20_000,
  })

  const targetField = dialog.locator('label').filter({ hasText: /^入库\/接收主体/ }).first()
  const target = targetField.locator('select').first()
  await expect(target).toBeEnabled({ timeout: 20_000 })
  const targetTexts = await target.locator('option').allTextContents()
  expect(targetTexts, '接收端应列出他市场').toContain(`市场 · ${TOPO.MARKET_OTHER_NAME}`)
  expect(targetTexts, '接收端不应包含调出市场自己').not.toContain(`市场 · ${TOPO.MARKET_NAME}`)
  expect(targetTexts.some((text) => text.startsWith('门店 · ')), '接收端不应出现门店').toBe(false)

  // ══ 2. 提交 ═══════════════════════════════════════════════════════
  await selectContaining(target, `市场 · ${TOPO.MARKET_OTHER_NAME}`)
  await dialog.locator('textarea').first().fill(REMARK)
  await page.waitForTimeout(500)
  // 发起端是只读 output、不是 select，所以明细行下拉的位置与 createGenericDoc 的假设不同：
  // 0=单据类型 1=入库主体 2=来源批次 3=SKU
  const selects = dialog.locator('select')
  await selectContaining(selects.nth(3), inv01.supplySkuName)
  const lot = selects.nth(2)
  await expect(lot).toBeEnabled({ timeout: 20_000 })
  const lotTexts = await lot.locator('option').allTextContents()
  const lotIndex = lotTexts.findIndex((text, i) => i > 0 && Number(text.match(/可用\s*([\d.]+)/)?.[1] ?? '0') >= QTY)
  expect(lotIndex, `南昌凤御没有可用量 >= ${QTY} 的批次：${JSON.stringify(lotTexts)}`).toBeGreaterThan(0)
  await lot.selectOption({ index: lotIndex })
  await dialog.getByPlaceholder('数量').fill(String(QTY))
  await dialog.getByRole('button', { name: '提交' }).click()
  await expect(dialog).toBeHidden({ timeout: 30_000 })

  const mtoId = docIdByRemark('市场间调货出库', REMARK)
  expect(mtoId, '市场间调货出库落库').toMatch(/^MTO/)
  expect(docStatus(mtoId)).toBe('待收货')
  expect(srcBefore - lotQtyAll(TOPO.MARKET, inv01.supplySkuId), `${TOPO.MARKET_NAME} 在手量 −${QTY}`).toBe(QTY)

  // ══ 3. 调出方的待办里没有这张单（scopeRole=target），产出区里有 ═════
  {
    const { inbox, produced } = await openMarketTransferDocsTab(page)
    await expect(produced.getByText(mtoId)).toBeVisible({ timeout: 20_000 })
    await expect(inbox.getByText(mtoId)).toHaveCount(0)
    await expect(inbox.getByRole('button', { name: `确认收货 ${mtoId}` })).toHaveCount(0)
  }

  // ══ 4. 调入方（MK2，只绑自贡凤御）在办理台待办里确认收货 ═══════════
  await login(page, INVT_ACCOUNTS.MK2.phone, INVT_PASS)
  const { inbox } = await openMarketTransferDocsTab(page)
  await inbox.getByRole('button', { name: `确认收货 ${mtoId}` }).click()
  const dlg = page.getByRole('dialog').filter({ hasText: mtoId })
  await dlg.getByRole('button', { name: '确认收货', exact: true }).click()
  // 先读出真实 toast 再断言：失败时报错里带的是服务端文案（如 PERMISSION_DENIED），而不只是「不匹配」
  const toast = await peekToast(page, 30_000)
  expect(toast, `收货 toast：${toast || '(未出现任何 toast)'}`).toMatch(/收货已确认/)
  expect(docStatus(mtoId)).toBe('已完成')
  // 入库单是否继承备注以实现为准（INV-05 同样两路取号）：先按备注找，找不到再从 toast 里取
  const mtiId = docIdByRemark('市场间调货入库', REMARK) || (toast.match(/已生成入库单\s*(\S+)/)?.[1] ?? '')
  expect(mtiId, '收货生成市场间调货入库').toMatch(/^MTI/)
  expect(
    lotQtyAll(TOPO.MARKET_OTHER, inv01.supplySkuId) - dstBefore,
    `${TOPO.MARKET_OTHER_NAME} 在手量 +${QTY}`,
  ).toBe(QTY)
})
