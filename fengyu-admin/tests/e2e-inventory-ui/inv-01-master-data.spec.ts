/**
 * INV-01：基础档案建档（供应商 → 库存 SKU → 销售商品组成 → 报货福利方案）
 *
 * dev 库初始 0 个库存 SKU，后续所有链路都依赖本 spec 建出的档案。
 *
 * 本 spec 在**期初门禁关闭态**下运行，顺带验证一个事实：主数据 CRUD 不受
 * assertInventoryBusinessWritable 保护（门禁只守 createDoc/approve/reject/receive，
 * engine.ts:2677/2839/2905/2950），所以建档不需要先开闸。
 *
 * 同时承载两条固定 UX 断言（读代码时已定性，非扫描推测）：
 *   UX-FIXED-01  SKU 的「供货商」是裸 Input，且 inventory_skus 无 supplier_id 外键
 *   UX-A11Y-01   供应商表单的 <label> 未与控件关联（无 htmlFor、未包裹）
 */

import { test, expect } from '@playwright/test'
import {
  BASE,
  INVT_ACCOUNTS,
  INVT_PASS,
  NS,
  TOPO,
  login,
  psql,
  recordVerdict,
  sqlStr,
  summarize,
  writeCtx,
  type Verdict,
} from './_helpers/env'

test.setTimeout(300_000)

const STAMP = Date.now().toString().slice(-8)
const SUPPLIER_NAME = `${NS}-供应商-${STAMP}`
const SKU_SUPPLY_NAME = `${NS}-供应链品-${STAMP}`
const SKU_SELF_NAME = `${NS}-自采品-${STAMP}`

/** 说明.md §1.5 算例：核算价 4000 × 市场折扣 25% = 市场进货价 1000 */
const ACCOUNTING_PRICE = 4000
const MARKET_DISCOUNT = 25
const EXPECTED_MARKET_PRICE = 1000

test('INV-01：基础档案建档 + 六价体系 + 公式价校验', async ({ browser }) => {
  const verdicts: Verdict[] = []
  const ctx = await browser.newContext()
  const page = await ctx.newPage()
  page.on('console', (m) => { if (m.type() === 'error') console.log(`[browser-err] ${m.text()}`) })

  try {
    await login(page, INVT_ACCOUNTS.ADM.phone, INVT_PASS)

    // ── Step 1: 新建供应商 ────────────────────────────────────────
    console.log('[INV-01] Step 1: 新建供应商')
    await page.goto(`${BASE}/inventory/suppliers`)
    await page.waitForLoadState('networkidle')
    await page.getByRole('button', { name: /新建供应商/ }).click()
    const supDialog = page.getByRole('dialog')
    await expect(supDialog.getByText('新建供应商')).toBeVisible({ timeout: 10_000 })

    // UX-A11Y-01：供应商表单的 label 是游离的 <label>（无 htmlFor、未包裹 input），
    // getByLabel 因此失效 —— 屏幕阅读器同样读不到字段名。只能按 DOM 顺序定位。
    const labelBound = await supDialog
      .getByLabel('供应商名称 *')
      .count()
      .catch(() => 0)
    recordVerdict(
      verdicts,
      'UX-A11Y-01: 供应商表单 label 与控件已关联（期望 true，实测将失败）',
      labelBound > 0,
      `getByLabel 命中数=${labelBound}`,
    )

    const supInputs = supDialog.locator('input')
    await supInputs.nth(0).fill(SUPPLIER_NAME)      // 供应商名称 *
    await supInputs.nth(1).fill('INVT-联系人')       // 联系人
    await supInputs.nth(2).fill('13900000000')       // 联系电话
    await supInputs.nth(3).fill('INVT-地址')         // 地址
    await supDialog.getByRole('button', { name: /创建供应商/ }).click()
    await expect(page.getByText(/供应商已创建/)).toBeVisible({ timeout: 15_000 })

    const supplierId = psql(
      `SELECT supplier_id FROM inventory_suppliers WHERE name = ${sqlStr(SUPPLIER_NAME)}`,
    )
    recordVerdict(verdicts, 'supplier: 落库成功', Boolean(supplierId), supplierId)
    recordVerdict(
      verdicts,
      'supplier: 默认启用',
      psql(`SELECT is_active FROM inventory_suppliers WHERE name = ${sqlStr(SUPPLIER_NAME)}`) === 't',
      'is_active',
    )

    // ── Step 2: 新建供应链 SKU（公式价，§1.5 / §10.1）──────────────
    console.log('[INV-01] Step 2: 新建供应链 SKU')
    await page.goto(`${BASE}/inventory/skus`)
    await page.waitForLoadState('networkidle')
    await page.getByRole('button', { name: /新建/ }).first().click()
    const skuDialog = page.getByRole('dialog')
    await expect(skuDialog.getByText('新建库存商品')).toBeVisible({ timeout: 10_000 })

    // ── UX-FIXED-01：供货商必须是选择器（#132 已修，两条断言现在应当转绿）──────
    // 不预设 role：若写死 getByRole('textbox') 就等于假定了它是 input，
    // 「是不是选择器」这个检测本身会失去意义。改为按 label 包裹关系取其内部控件。
    // 注意 #132 把「+ 新建供应商」按钮与提示文字放在了 label **外面**，
    // 所以 /^供货商$/ 这个精确匹配依然成立，label 内也仍然只有一个控件。
    const supplierField = skuDialog
      .locator('label')
      .filter({ hasText: /^供货商$/ })
      .locator('input, select, textarea')
      .first()
    const supplierTag = await supplierField.evaluate((el) => el.tagName.toLowerCase()).catch(() => 'missing')
    recordVerdict(
      verdicts,
      'UX-FIXED-01: SKU 的「供货商」是选择器而非自由文本（#132）',
      supplierTag === 'select',
      `tagName=${supplierTag}`,
    )
    // 更深一层：数据模型上要有真外键，否则「选择器」只是个摆设
    const hasSupplierFk = psql(
      `SELECT count(*) FROM information_schema.columns
        WHERE table_name = 'inventory_skus' AND column_name = 'supplier_id'`,
    )
    recordVerdict(
      verdicts,
      'UX-FIXED-01b: inventory_skus 有 supplier_id 外键（#132）',
      hasSupplierFk === '1',
      `supplier_id 列数=${hasSupplierFk}`,
    )

    // 定位用 role + exact name：Field 的 <label> 包裹控件，但「市场进货价」那个
    // label 里还塞了整段说明文字（"公式价 = 核算价 × 市场折扣；手工覆盖必须留痕原因"），
    // 用 getByLabel('核算价') 会被这段文字 substring 命中，产生 strict mode violation。
    const skuText = (name: string) => skuDialog.getByRole('textbox', { name, exact: true })
    await skuText('产品名称 *').fill(SKU_SUPPLY_NAME)
    await skuText('规格').fill('INVT-规格')
    // Step 1 刚建的档案，这里直接从下拉选（#132 前只能手打）
    await supplierField.selectOption({ label: SUPPLIER_NAME })
    await skuText('产品系列').fill('INVT-系列')
    await skuText('供应链采购价').fill('800')
    await skuText('门店进货价').fill('1200')
    await skuText('市场员工购价').fill('1500')
    await skuText('顾客零售价').fill('5980')
    await skuText('核算价').fill(String(ACCOUNTING_PRICE))
    await skuText('市场折扣（25 表示 25%）').fill(String(MARKET_DISCOUNT))
    await skuDialog.getByRole('button', { name: /^保存|创建|确定$/ }).last().click()
    await expect(page.getByText(/库存商品已创建/)).toBeVisible({ timeout: 15_000 })

    const supplySku = psql(
      `SELECT sku_id || '|' || source_type || '|' || COALESCE(market_purchase_price::text,'') || '|' ||
              COALESCE(market_purchase_price_mode,'') || '|' || COALESCE(supplier,'') || '|' ||
              COALESCE(supplier_id,'')
         FROM inventory_skus WHERE product_name = ${sqlStr(SKU_SUPPLY_NAME)}`,
    )
    const [supplySkuId, sourceType, marketPrice, priceMode, skuSupplier, skuSupplierId] = supplySku.split('|')
    recordVerdict(verdicts, 'sku: 供应链 SKU 落库', Boolean(supplySkuId), supplySkuId)
    recordVerdict(verdicts, 'sku: source_type = 供应链', sourceType === '供应链', sourceType)
    recordVerdict(
      verdicts,
      `sku: 市场进货价按公式 = 核算价×折扣 = ${EXPECTED_MARKET_PRICE}（§1.5/§10.1）`,
      Number(marketPrice) === EXPECTED_MARKET_PRICE,
      marketPrice,
    )
    recordVerdict(verdicts, 'sku: 价格模式 = 公式', priceMode === '公式', priceMode)
    recordVerdict(
      verdicts,
      'sku: 供货商关联到档案 supplier_id（#132）',
      skuSupplierId === supplierId && supplierId.length > 0,
      `supplier_id=${skuSupplierId} 期望=${supplierId}`,
    )
    recordVerdict(
      verdicts,
      'sku: supplier 名称快照由档案派生写入（批次快照 ensureLotFromSku 取这一列）',
      skuSupplier === SUPPLIER_NAME,
      skuSupplier,
    )

    // ── Step 3: 手工覆盖必须填原因（§10.1）────────────────────────
    console.log('[INV-01] Step 3: 手工覆盖原因必填校验')
    await page.goto(`${BASE}/inventory/skus?q=${encodeURIComponent(SKU_SUPPLY_NAME)}`)
    await page.waitForLoadState('networkidle')
    await page.waitForTimeout(800)
    await page.getByRole('button', { name: /编辑/ }).first().click()
    const editDialog = page.getByRole('dialog')
    await expect(editDialog.getByText('编辑库存商品')).toBeVisible({ timeout: 10_000 })

    // 「市场进货价」label 同时包住 Select + Input，且 label 文本后面还接了整段说明，
    // getByLabel 既有歧义又匹配不上 —— 按 label 包裹关系取内部控件。
    const priceLabel = editDialog.locator('label').filter({ hasText: /^市场进货价/ }).first()
    await priceLabel.locator('select').selectOption('手工覆盖')
    await priceLabel.locator('input').fill('999')
    await editDialog.getByRole('button', { name: /^保存|更新|确定$/ }).last().click()
    // 注意：locator.isVisible() 是**即时**检查且不接受 timeout —— 用它会在 toast
    // 渲染出来之前就返回 false。凡是断言「稍后出现」一律用 waitFor / expect.toBeVisible。
    const reasonBlocked = await page
      .getByText(/手工覆盖市场进货价时必须填写原因/)
      .waitFor({ state: 'visible', timeout: 10_000 })
      .then(() => true)
      .catch(() => false)
    recordVerdict(verdicts, 'sku: 手工覆盖未填原因被拦截（§10.1）', reasonBlocked, String(reasonBlocked))

    // 填原因后应保存成功
    const reasonField = editDialog.locator('label').filter({ hasText: /^手工覆盖原因/ }).locator('textarea').first()
    if (await reasonField.count() > 0) {
      await reasonField.fill('INVT 测试覆盖原因')
      await editDialog.getByRole('button', { name: /^保存|更新|确定$/ }).last().click()
      await expect(page.getByText(/库存商品已更新/)).toBeVisible({ timeout: 15_000 })
      const overridden = psql(
        `SELECT market_purchase_price_mode || '|' || COALESCE(market_purchase_price::text,'') || '|' ||
                COALESCE(market_purchase_price_override_reason,'')
           FROM inventory_skus WHERE product_name = ${sqlStr(SKU_SUPPLY_NAME)}`,
      )
      const [mode2, price2, reason2] = overridden.split('|')
      recordVerdict(verdicts, 'sku: 覆盖后 mode = 手工覆盖', mode2 === '手工覆盖', mode2)
      recordVerdict(verdicts, 'sku: 覆盖后价格 = 999', Number(price2) === 999, price2)
      recordVerdict(verdicts, 'sku: 覆盖原因已落库', reason2.length > 0, reason2)

      // 还原为公式价，避免影响后续链路的价格断言
      psql(
        `UPDATE inventory_skus
            SET market_purchase_price_mode = '公式',
                market_purchase_price = ${EXPECTED_MARKET_PRICE},
                market_purchase_price_override_reason = NULL
          WHERE product_name = ${sqlStr(SKU_SUPPLY_NAME)}`,
      )
    } else {
      recordVerdict(verdicts, 'sku: 覆盖原因字段存在', false, '未找到「覆盖原因」输入框')
    }
    await page.keyboard.press('Escape')

    // ── Step 4: 新建市场自采 SKU ──────────────────────────────────
    console.log('[INV-01] Step 4: 新建市场自采 SKU')
    await page.goto(`${BASE}/inventory/skus`)
    await page.waitForLoadState('networkidle')
    await page.getByRole('button', { name: /新建/ }).first().click()
    const selfDialog = page.getByRole('dialog')
    await expect(selfDialog.getByText('新建库存商品')).toBeVisible({ timeout: 10_000 })
    const selfField = (labelRe: RegExp) =>
      selfDialog.locator('label').filter({ hasText: labelRe }).first()
    await selfField(/^产品名称/).locator('input').fill(SKU_SELF_NAME)
    await selfField(/^来源/).locator('select').selectOption('市场自采')
    await selfField(/^归属市场/).locator('select').selectOption({ label: TOPO.MARKET_NAME })
    await selfField(/^门店进货价/).locator('input').fill('300')
    await selfField(/^顾客零售价/).locator('input').fill('880')
    await selfDialog.getByRole('button', { name: /^保存|创建|确定$/ }).last().click()
    await expect(page.getByText(/库存商品已创建/)).toBeVisible({ timeout: 15_000 })

    const selfSku = psql(
      `SELECT sku_id || '|' || source_type || '|' || COALESCE(owner_market_id,'')
         FROM inventory_skus WHERE product_name = ${sqlStr(SKU_SELF_NAME)}`,
    )
    const [selfSkuId, selfSource, ownerMarket] = selfSku.split('|')
    recordVerdict(verdicts, 'sku: 自采 SKU 落库', Boolean(selfSkuId), selfSkuId)
    recordVerdict(verdicts, 'sku: source_type = 市场自采', selfSource === '市场自采', selfSource)
    recordVerdict(
      verdicts,
      `sku: 归属市场 = ${TOPO.MARKET_NAME}`,
      ownerMarket === TOPO.MARKET || ownerMarket === TOPO.MARKET.replace('org-市场-', 'store-'),
      ownerMarket,
    )

    // ── Step 5: 确认主数据不受期初门禁限制 ─────────────────────────
    const gate = psql(`SELECT COALESCE(status,'待初始化') FROM inventory_cutover_states WHERE cutover_key='workfine_inventory'`) || '待初始化'
    recordVerdict(
      verdicts,
      '门禁：主数据 CRUD 在门禁关闭态下仍可写入（设计如此，engine 只守单据路径）',
      gate !== '已初始化' ? Boolean(supplySkuId && selfSkuId) : true,
      `gate=${gate || '待初始化'}`,
    )

    writeCtx('inv01', {
      supplierId,
      supplierName: SUPPLIER_NAME,
      supplySkuId,
      supplySkuName: SKU_SUPPLY_NAME,
      selfSkuId,
      selfSkuName: SKU_SELF_NAME,
      accountingPrice: ACCOUNTING_PRICE,
      marketDiscount: MARKET_DISCOUNT,
      expectedMarketPrice: EXPECTED_MARKET_PRICE,
    })
  } finally {
    await ctx.close()
    summarize(1, verdicts)
  }

  // 仍未修的 UX 固定断言单独列出、不阻断链路建设。
  // ⚠️ 修好一条就要从这里挪走，否则它会从「待修清单」悄悄变成「退化了也不报」：
  // UX-FIXED-01 / 01b 已由 #132 修复，现在是正式守护 —— 把供货商改回裸 Input
  // 或删掉 supplier_id 外键，本 spec 会直接红。UX-A11Y-01 仍挂起（#135）。
  const PENDING_UX_CHECKS = ['UX-A11Y-01']
  const isPendingUx = (check: string) => PENDING_UX_CHECKS.some((prefix) => check.startsWith(prefix))
  const uxFindings = verdicts.filter((v) => v.verdict === 'FAIL' && isPendingUx(v.check))
  const functional = verdicts.filter((v) => v.verdict === 'FAIL' && !isPendingUx(v.check))
  if (uxFindings.length > 0) {
    console.log(`\n[INV-01] ⚠️ UX 发现 ${uxFindings.length} 条（已知缺陷，记入 UX-FINDINGS.md）:`)
    console.log(JSON.stringify(uxFindings, null, 2))
  }
  expect(functional, `INV-01 功能失败项:\n${JSON.stringify(functional, null, 2)}`).toHaveLength(0)
})
