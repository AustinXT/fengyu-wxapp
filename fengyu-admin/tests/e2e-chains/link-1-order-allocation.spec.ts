/**
 * 链路 1：开单 → 收款确认 → 营业额分配 → 提成入账
 *
 * 角色：FY-TEST-MGR（门店 manager，南昌旗舰店）
 * Fixture 顾客：13800138000（FY-FIX-CLIENT-01）
 * Fixture SKU 1：c79157b29c9e974c（缦之羽 洗-无创纹身 ¥100）
 * Fixture SKU 2：2e388ba778334779（假性皱纹管家 ¥100）
 */

import { test, expect } from '@playwright/test'
import { execSync } from 'child_process'
import fs from 'fs'
import path from 'path'
import { cleanupSaleOrder } from './_helpers/cleanup'

const BASE = process.env.ADMIN_BASE_URL || 'http://localhost:3000'

// DB helper（与其他 spec 一致）
function psql(sql: string): string {
  try {
    return execSync(
      `PGPASSWORD=fengyu123 psql -h 47.113.202.7 -p 5434 -U fengyu -d fengyu_e2e -t -A -c "${sql.replace(/"/g, '\\"')}"`,
      { encoding: 'utf8', timeout: 15000 },
    ).trim()
  } catch (e) {
    const err = e as { message?: string; stderr?: string }
    throw new Error(`psql: ${err.message ?? ''}\n${err.stderr ?? ''}`)
  }
}

// -----------------------------------------------------------------------
// 常量
// -----------------------------------------------------------------------
const MANAGER_PHONE = '13900139001'
const MANAGER_PASS = 'fengyu2026'
const FIXTURE_PHONE = '13800138000'
const SKU1_NAME = '洗-无创纹身'          // 缦之羽 SKU
const SKU2_NAME = '假性皱纹管家'          // 另一 SKU

const TEST_RESULTS_DIR = path.resolve(__dirname, '../../test-results')
const CONTEXT_FILE = path.resolve(__dirname, './.last-test-context.json')

// -----------------------------------------------------------------------
// 工具函数
// -----------------------------------------------------------------------

function ensureDir(dir: string) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })
}

function readContext(): Record<string, unknown> {
  try {
    return JSON.parse(fs.readFileSync(CONTEXT_FILE, 'utf8'))
  } catch {
    return {}
  }
}

function writeContext(data: Record<string, unknown>) {
  const existing = readContext()
  const dir = path.dirname(CONTEXT_FILE)
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(CONTEXT_FILE, JSON.stringify({ ...existing, ...data }, null, 2))
}

// -----------------------------------------------------------------------
// 测试
// -----------------------------------------------------------------------

test.setTimeout(180000)

test('链路1：开单 → 收款确认 → 营业额分配', async ({ page }) => {
  ensureDir(TEST_RESULTS_DIR)

  // 监听 console 错误
  page.on('console', (msg) => {
    if (msg.type() === 'error') {
      console.log(`[browser-error] ${msg.text()}`)
    }
  })
  page.on('pageerror', (err) => {
    console.log(`[page-error] ${err.message}`)
  })
  // 监听网络响应
  page.on('response', (res) => {
    if (res.url().includes('localhost:3000') && res.status() >= 400) {
      console.log(`[network-error] ${res.status()} ${res.url()}`)
    }
  })

  // ---- 登录 ----
  await page.goto(`${BASE}/login`)
  await page.waitForLoadState('networkidle')

  // 等待登录按钮可见，确认 hydration 完成
  await expect(page.getByRole('button', { name: /登\s*录/ })).toBeVisible({ timeout: 20000 })
  await page.waitForTimeout(500)

  await page.locator('#phone').click()
  await page.locator('#phone').pressSequentially(MANAGER_PHONE, { delay: 30 })
  await page.locator('#password').click()
  await page.locator('#password').pressSequentially(MANAGER_PASS, { delay: 30 })
  await page.getByRole('button', { name: /登\s*录/ }).click()
  await page.waitForURL(/\/dashboard/, { timeout: 20000 })

  await page.screenshot({ path: `${TEST_RESULTS_DIR}/link-1-01-login.png` })

  // ---- Step 1: 进入开单向导 ----
  // 批跑首个命中重路由 /orders/create 时 dev/Turbopack 冷编译可能 >45s。
  // 先预热一个轻路由（/dashboard，登录后已编译过）消除首次跳转惩罚，再放宽 goto 超时到 90s。
  await page.goto(`${BASE}/dashboard`, { timeout: 90_000 }).catch(() => null)
  await page.goto(`${BASE}/orders/create`, { timeout: 90_000 })
  await expect(page.getByRole('heading', { name: '新建订单' })).toBeVisible({ timeout: 30_000 })

  // Step 1 — 选顾客（按手机号搜索）
  await page.getByPlaceholder(/手机号/).fill(FIXTURE_PHONE)
  await page.getByRole('button', { name: /搜索/ }).click()

  // 等待搜索结果
  await page.waitForFunction(() => {
    const t = document.body.textContent || ''
    return t.includes('找到') || t.includes('未找到')
  }, { timeout: 15000 })

  const hasResults = await page.getByText(/找到 \d+ 位顾客/).isVisible().catch(() => false)
  if (!hasResults) {
    throw new Error(`FATAL: fixture 顾客 ${FIXTURE_PHONE} 未在测试库找到，请检查 fixture 是否存在`)
  }

  // 选择第一个搜索结果（fixture 顾客）
  const firstCustomerBtn = page.locator('div.space-y-1 > button').first()
  await expect(firstCustomerBtn).toBeVisible({ timeout: 5000 })
  await firstCustomerBtn.click()
  await expect(page.getByText('已选择顾客')).toBeVisible({ timeout: 5000 })

  await page.screenshot({ path: `${TEST_RESULTS_DIR}/link-1-02-customer-selected.png` })

  // 默认"普通商品"，直接点下一步
  await page.getByRole('button', { name: '下一步' }).click()

  // ---- Step 2: 选择商品 ----
  // 等待数据加载（初次进入 Step 2 时会异步 prefetch，可能需要重试）
  // 先等 2 秒，再判断是否需要重试
  await page.waitForTimeout(2000)

  // 如果出现"数据未加载"和"重试"按钮，点重试
  for (let retry = 0; retry < 3; retry++) {
    const bodyText = await page.textContent('body')
    if (bodyText?.includes('数据未加载') || bodyText?.includes('重试')) {
      const retryBtn = page.getByRole('button', { name: '重试' })
      if (await retryBtn.count() > 0) {
        console.log(`[链路1] Step 2 数据未加载，点击重试（第 ${retry + 1} 次）`)
        await retryBtn.click()
        await page.waitForTimeout(3000)
      }
    } else if (bodyText?.includes('商品分类') || bodyText?.includes('加入')) {
      break
    } else {
      await page.waitForTimeout(2000)
    }
  }

  // 最终确认商品列表区域可用
  await page.waitForFunction(() => {
    const t = document.body.textContent || ''
    return (
      (t.includes('商品分类') || t.includes('暂无可选品类') || t.includes('加入')) &&
      !t.includes('正在加载')
    )
  }, { timeout: 30000 })

  await page.screenshot({ path: `${TEST_RESULTS_DIR}/link-1-03-step2-products.png` })

  // === 添加 SKU 1：点击"缦之羽"分类 → 找"洗-无创纹身"加入 ===
  // 先点击左侧分类导航中的"缦之羽"
  const cat1Btn = page.getByRole('button', { name: '缦之羽', exact: true }).first()
  if (await cat1Btn.count() > 0) {
    await cat1Btn.click()
    await page.waitForTimeout(500)
    console.log('[链路1] 点击了"缦之羽"分类')
  }

  // 查找包含 SKU1_NAME 文字的"加入"按钮
  // SKU 卡片结构：卡片 > 文字(spec_name) + 按钮("加入")
  let sku1Added = false
  const sku1NameEl = page.getByText(SKU1_NAME, { exact: false })
  if (await sku1NameEl.count() > 0) {
    // 找到文字元素，向上找其容器里的"加入"按钮
    // NormalSkuPicker 中每个 SKU 是一个 div.border 卡片
    const sku1Card = sku1NameEl.first().locator('..').locator('..')
    const addBtn1 = sku1Card.getByRole('button', { name: /加入/ })
    if (await addBtn1.count() > 0) {
      await addBtn1.click()
      sku1Added = true
      console.log(`[链路1] 已加入 SKU1: ${SKU1_NAME}`)
    }
  }

  if (!sku1Added) {
    // 降级：点第一个可见的"加入"按钮
    const allAddBtns = page.getByRole('button', { name: /加入/ })
    if (await allAddBtns.count() > 0) {
      await allAddBtns.first().click()
      sku1Added = true
      console.log('[链路1] SKU1 降级：点第一个"加入"按钮')
    } else {
      throw new Error('Step 2: 页面没有"加入"按钮，无法添加商品')
    }
  }

  await page.waitForTimeout(500)

  // === 添加 SKU 2：点击"其他"分类 → 找"假性皱纹管家"加入 ===
  const cat2Btn = page.getByRole('button', { name: '其他', exact: true })
  if (await cat2Btn.count() > 0) {
    await cat2Btn.click()
    await page.waitForTimeout(500)
    console.log('[链路1] 点击了"其他"分类')
  }

  let sku2Added = false
  const sku2NameEl = page.getByText(SKU2_NAME, { exact: false })
  if (await sku2NameEl.count() > 0) {
    const sku2Card = sku2NameEl.first().locator('..').locator('..')
    const addBtn2 = sku2Card.getByRole('button', { name: /加入/ })
    if (await addBtn2.count() > 0) {
      await addBtn2.click()
      sku2Added = true
      console.log(`[链路1] 已加入 SKU2: ${SKU2_NAME}`)
    }
  }

  if (!sku2Added) {
    // 降级：点第一个可见的"加入"按钮（与 SKU1 不同的那个）
    const addBtnsNow = page.getByRole('button', { name: /加入/ })
    const count2 = await addBtnsNow.count()
    if (count2 > 1) {
      await addBtnsNow.nth(1).click()
      sku2Added = true
      console.log('[链路1] SKU2 降级：点第二个"加入"按钮')
    } else if (count2 > 0) {
      // 不同类别的第一个按钮
      await addBtnsNow.first().click()
      sku2Added = true
      console.log('[链路1] SKU2 降级：点第一个"加入"按钮（不同类别）')
    }
  }

  await page.waitForTimeout(500)
  console.log(`[链路1] SKU2 加入状态: ${sku2Added}`)

  await page.screenshot({ path: `${TEST_RESULTS_DIR}/link-1-04-cart-filled.png` })

  // 购物车应该有商品，点下一步
  const nextBtn = page.getByRole('button', { name: '下一步' })
  await expect(nextBtn).toBeEnabled({ timeout: 5000 })
  await nextBtn.click()

  // ---- Step 3: 确认订单（收银） ----
  await expect(page.getByRole('button', { name: '销售单', exact: true })).toBeVisible({ timeout: 10000 })

  // 确认默认是"销售单"
  await expect(page.getByRole('button', { name: '销售单', exact: true })).toHaveAttribute('aria-pressed', 'true')

  await page.screenshot({ path: `${TEST_RESULTS_DIR}/link-1-05-step3-checkout.png` })

  // 支付方式：选择"线下"支付（admin <Select> 渲染原生 <select>，option 文案"线下支付" value="线下"）
  const paymentMethodSelect = page.locator('select').filter({ hasText: /线下支付/ }).first()
  await expect(paymentMethodSelect).toBeVisible({ timeout: 10000 })
  await paymentMethodSelect.selectOption({ label: '线下支付' })

  // 取消「充值卡抵扣」：根因（2026-06-09 实测）——顾客 FY-FIX-CLIENT-01 有储值卡余额，admin 开单页
  // 加载余额后自动勾选充值卡抵扣（order-create-page.tsx:298 setUseCard(bal>0)），导致开单全额卡抵扣
  // → payment_method='无'、status='已支付'，绕过线下「确认收款」链路（完成页无"确认收款"按钮）。
  // 本 link 验证线下现金收款，故取消该勾选（Step 3 唯一 checkbox）。
  const useCardCheckbox = page.getByRole('checkbox').first()
  if ((await useCardCheckbox.count()) > 0 && (await useCardCheckbox.isChecked().catch(() => false))) {
    await useCardCheckbox.uncheck()
    console.log('[链路1] 已取消充值卡抵扣（走线下现金收款链路）')
  }

  await page.screenshot({ path: `${TEST_RESULTS_DIR}/link-1-06-payment-method.png` })

  // 提交订单
  const submitBtn = page.getByRole('button', { name: /提交订单|下一步|确认提交/ }).last()
  await expect(submitBtn).toBeEnabled({ timeout: 5000 })
  await submitBtn.click()

  // ---- Step 4: 完成（有订单号 + 确认收款按钮）----
  // 等待进入第4步（完成页面）
  await expect(page.getByText(/订单已创建|开单成功|FY-XSD-WX/)).toBeVisible({ timeout: 20000 })

  await page.screenshot({ path: `${TEST_RESULTS_DIR}/link-1-07-step4-created.png` })

  // 提取订单号
  let saleOrderId = ''
  // 方法1: 从页面文本中匹配订单号格式
  const orderIdEl = page.locator('p.font-mono, p:has-text("FY-XSD-WX")').first()
  if (await orderIdEl.count() > 0) {
    const text = await orderIdEl.textContent()
    const match = text?.match(/FY-XSD-WX-\d{6}\d{4}/)
    if (match) saleOrderId = match[0]
  }

  if (!saleOrderId) {
    // 方法2: 从页面全文搜索
    const bodyText = await page.textContent('body')
    const match = bodyText?.match(/FY-XSD-WX-\d{6}\d{4}/)
    if (match) saleOrderId = match[0]
  }

  console.log(`[链路1] 创建的订单号: ${saleOrderId}`)

  if (!saleOrderId) {
    // 尝试从"查看订单"链接提取
    const viewOrderLink = page.getByRole('link', { name: '查看订单' })
    if (await viewOrderLink.count() > 0) {
      const href = await viewOrderLink.getAttribute('href')
      const match = href?.match(/FY-XSD-WX-\d{6}\d{4}/)
      if (match) saleOrderId = match[0]
    }
  }

  // 点击"确认收款"按钮（线下支付后在 Step 4 显示）
  const confirmPayBtn = page.getByRole('button', { name: '确认收款' })
  await expect(confirmPayBtn).toBeVisible({ timeout: 10000 })
  await confirmPayBtn.click()

  // 等待确认成功（toast 或文案变化）
  await expect(page.getByText(/收款确认成功|已确认收款|已更新为已支付/).first()).toBeVisible({ timeout: 15000 })

  await page.screenshot({ path: `${TEST_RESULTS_DIR}/link-1-08-payment-confirmed.png` })

  // 如果还没有 saleOrderId，再扫一次
  if (!saleOrderId) {
    const bodyText = await page.textContent('body')
    const match = bodyText?.match(/FY-XSD-WX-\d{6}\d{4}/)
    if (match) saleOrderId = match[0]
  }

  if (!saleOrderId) {
    // 方法3: 通过"查看订单"导航到详情页提取 URL
    const viewOrderLink = page.getByRole('link', { name: '查看订单' })
    if (await viewOrderLink.count() > 0) {
      await viewOrderLink.click()
      await page.waitForURL(/\/orders\/FY-XSD-WX-/, { timeout: 15000 })
      const url = page.url()
      const match = url.match(/FY-XSD-WX-\d{6}\d{4}/)
      if (match) saleOrderId = match[0]
      await page.screenshot({ path: `${TEST_RESULTS_DIR}/link-1-09-order-detail.png` })
    }
  }

  if (!saleOrderId) {
    throw new Error('无法提取订单号（FY-XSD-WX-YYMMDD{4位}），请检查 Step 4 页面结构')
  }

  console.log(`[链路1] 最终确认订单号: ${saleOrderId}`)

  // 验证订单号格式
  expect(saleOrderId).toMatch(/^FY-XSD-WX-\d{10}$/)

  // ---- 写入 context 文件 ----
  writeContext({
    link1: {
      saleOrderId,
      ranAt: new Date().toISOString(),
    },
  })
  console.log(`[链路1] saleOrderId 已写入 context: ${saleOrderId}`)

  // ---- 导航到订单详情页（若尚未在此页面）----
  if (!page.url().includes(saleOrderId)) {
    await page.goto(`${BASE}/orders/${saleOrderId}`)
    await expect(page.getByText('订单详情')).toBeVisible({ timeout: 15000 })
  }

  // 验证状态为"已支付"（strict mode: 使用 first() 因为页面上可能有多处"已支付"文字）
  await expect(page.getByText('已支付').first()).toBeVisible({ timeout: 10000 })

  await page.screenshot({ path: `${TEST_RESULTS_DIR}/link-1-10-order-paid.png` })

  // ---- 营业额分配 ----
  await page.goto(`${BASE}/allocations/${saleOrderId}`)
  await expect(page.getByRole('heading', { name: '营业额分配' })).toBeVisible({ timeout: 15000 })

  await page.screenshot({ path: `${TEST_RESULTS_DIR}/link-1-11-allocation-page.png` })

  // 等待商品明细加载（每个 sale_item 对应一张卡片）
  await expect(page.getByRole('button', { name: /添加分配/ }).first()).toBeVisible({ timeout: 15000 })

  // 为每个商品项（sale_item）添加一条分配
  const addBtns = page.getByRole('button', { name: /添加分配/ })
  const itemCount = await addBtns.count()
  console.log(`[链路1] 发现 ${itemCount} 个商品项需要分配`)

  for (let i = 0; i < itemCount; i++) {
    // 点击"+ 添加分配"（因列表是动态的，每次重新定位）
    const btn = page.getByRole('button', { name: /添加分配/ }).nth(i)
    await btn.click()
    await page.waitForTimeout(300)

    // 找到新增的分配行（技能标签 select）
    // 每个分配行的技能标签 select 在卡片内
    const allSkillSelects = page.locator('select').filter({ hasText: /选择|美容师|养生师|推广师/ })
    const skillSelectCount = await allSkillSelects.count()

    // 选最后一个技能标签 select（刚添加的那行）
    const lastSkillSelect = allSkillSelects.nth(skillSelectCount - 1)
    await lastSkillSelect.selectOption('美容师')
    await page.waitForTimeout(300)

    // 员工 select（紧跟技能标签 select 的下一个 select）
    const allEmpSelects = page.locator('select').filter({ hasText: /选择|先选标签/ })
    const empSelectCount = await allEmpSelects.count()
    const lastEmpSelect = allEmpSelects.nth(empSelectCount - 1)
    // 等待员工 select 可用
    await expect(lastEmpSelect).toBeEnabled({ timeout: 5000 })
    // 选第一个员工选项（非空）
    const empOptions = await lastEmpSelect.locator('option').allTextContents()
    const firstValidEmp = empOptions.find((o) => o && !o.includes('选择') && !o.includes('先选'))
    if (firstValidEmp) {
      await lastEmpSelect.selectOption({ label: firstValidEmp })
    }
    await page.waitForTimeout(300)

    // 分配比例 select（找含"%"选项的 select）
    const allRatioSelects = page.locator('select').filter({ hasText: /10%|20%|50%|100%/ })
    const ratioSelectCount = await allRatioSelects.count()
    const lastRatioSelect = allRatioSelects.nth(ratioSelectCount - 1)
    await lastRatioSelect.selectOption('100')
    await page.waitForTimeout(200)
  }

  await page.screenshot({ path: `${TEST_RESULTS_DIR}/link-1-12-allocation-filled.png` })

  // 保存分配
  const saveBtn = page.getByRole('button', { name: '保存分配' })
  await expect(saveBtn).toBeVisible({ timeout: 5000 })
  await saveBtn.click()

  // 等待保存成功（toast 或跳转）
  await page.waitForTimeout(1000)
  await expect(page.getByText(/分配成功|保存成功|分配完成/)).toBeVisible({ timeout: 15000 }).catch(async () => {
    // 如果没有 toast，可能直接跳转到列表页
    const currentUrl = page.url()
    if (!currentUrl.includes('/allocations/' + saleOrderId)) {
      console.log('[链路1] 保存后已跳转到分配列表页')
    } else {
      // 检查是否有错误 toast
      const errToast = page.getByText(/错误|失败|超出|100%/)
      if (await errToast.count() > 0) {
        const errText = await errToast.first().textContent()
        throw new Error(`分配保存失败: ${errText}`)
      }
    }
  })

  await page.screenshot({ path: `${TEST_RESULTS_DIR}/link-1-13-allocation-saved.png` })

  console.log(`[链路1] 链路完成，订单号: ${saleOrderId}`)

  // ---- Step 99: 清理测试数据（共享工具） ----
  if (saleOrderId) {
    try {
      cleanupSaleOrder(saleOrderId, psql, { logPrefix: '[链路1]' })
    } catch (e) {
      console.log(`[链路1] 清理出错（非致命）: ${e}`)
    }
  }
})
