/**
 * 链路 36：admin 手动拉取 WorkFine 历史订单（PullWorkfineDialog 全链路）
 *
 * 主题：admin /legacy-orders 页面"拉取顾客历史"按钮 + PullWorkfineDialog 3 步流程
 *   1. 搜索：phone / customer_id → searchWorkfineCustomer
 *   2. 预览：选中候选 → previewWorkfineOrders（标记 alreadyImported / storeMatched）
 *   3. 导入：勾选 → importWorkfineOrdersByCustomer → INSERT sale_orders, status='未审核'
 *
 * 关键引用：
 *   - actions/legacy-orders.ts            searchWorkfineCustomer / previewWorkfineOrders / importWorkfineOrdersByCustomer
 *   - lib/workfine-mssql.ts               MOCK_WORKFINE=1 走 fixtures（WF-MOCK-001 / WF-ORD-001 / ¥998 / 南昌旗舰店）
 *   - _components/pull-workfine-dialog.tsx Dialog UI
 *   - _components/legacy-orders-page.tsx  顶部"拉取顾客历史"按钮（仅 canPull=true 时渲染）
 *
 * ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 * 前置条件（运行前请自查）
 * ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 *   1) Dev server 启动时必须设置 `MOCK_WORKFINE=1`，否则 actions 会去连真 MSSQL。
 *      推荐：`MOCK_WORKFINE=1 bun run dev`（或在 .env.local 加 `MOCK_WORKFINE=1`）
 *
 *   2) PG（5434 fengyu）已 seed scope fixtures（含 store-nc01 = "南昌旗舰店"），
 *      亦即 _helpers/seed-scope-fixtures.sql 已跑过；FY-TEST-ADM/MGR/HR 三账号可登录。
 *      mock fixture 的 storeName 已对齐为"南昌旗舰店"以保证 storeMatched=true。
 *
 *   3) 测试自清理：beforeAll/afterAll 会 DELETE FROM sale_orders WHERE sale_order_id='WF-ORD-001'
 *      AND legacy_source='workfine'（且会清掉对应的 operation_logs）。
 *
 * 备注：HR 角色不持 'legacy_order:pull'，用作"无权限不见拉取按钮"的反例。
 */

import { test, expect } from '@playwright/test'
import { BASE, TEST_PHONES, psql, login } from './_helpers/scope-helpers'

const MOCK_PHONE = '13800138000'
const MOCK_ORDER_NO = 'WF-ORD-001'
const MOCK_CUSTOMER_ID = 'WF-MOCK-001'

/** 清理 WF-ORD-001（含可能关联的 operation_logs / sale_items / sale_allocations 等子表） */
function cleanupMockOrder(): void {
  // 子表（防外键）：sale_items / sale_allocations 现阶段不会被 import 流程写入（仅 sale_orders 一条），
  // 但为安全起见，先清子表再清主表
  psql(`DELETE FROM sale_allocations WHERE sale_order_id = '${MOCK_ORDER_NO}'`)
  psql(`DELETE FROM sale_items WHERE sale_order_id = '${MOCK_ORDER_NO}'`)
  psql(
    `DELETE FROM operation_logs WHERE entity_type = 'sale_order' AND entity_id = '${MOCK_ORDER_NO}'`,
  )
  psql(`DELETE FROM sale_orders WHERE sale_order_id = '${MOCK_ORDER_NO}' AND legacy_source = 'workfine'`)
}

test.describe('链路36：admin 手动拉取 WorkFine 历史订单', () => {
  // dev mode 首次编译每个页面/dialog 都慢，给宽裕一点
  test.setTimeout(180_000)

  test.beforeAll(() => {
    // 跳过条件：测试 PG 中没有 "南昌旗舰店"（mock fixture 依赖此 store_name）
    const storeCount = parseInt(
      psql(`SELECT COUNT(*)::text FROM stores WHERE store_name = '南昌旗舰店'`),
      10,
    )
    if (storeCount === 0) {
      throw new Error(
        '前置缺失：测试 PG (5434 fengyu) 中没有 store_name="南昌旗舰店"，请先跑 seed-scope-fixtures.sql',
      )
    }
    cleanupMockOrder()
  })

  test.afterAll(() => {
    cleanupMockOrder()
  })

  test('Test 1: /legacy-orders 入口 - 完整 search → preview → import 链路', async ({ browser }) => {
    const ctx = await browser.newContext()
    const page = await ctx.newPage()
    try {
      await login(page, TEST_PHONES.ADM)

      // 跳到 /legacy-orders
      await page.goto(`${BASE}/legacy-orders`, { waitUntil: 'domcontentloaded' })
      await page.waitForLoadState('networkidle')

      // 点击"拉取顾客历史"按钮 — Dialog 打开
      const pullBtn = page.getByRole('button', { name: /拉取顾客历史/ })
      await expect(pullBtn).toBeVisible({ timeout: 60_000 })
      await pullBtn.click()

      // Dialog 出现，标题包含"拉取顾客历史订单"
      const dialogTitle = page.getByText(/拉取顾客历史订单.*WorkFine/)
      await expect(dialogTitle).toBeVisible({ timeout: 10_000 })

      // ── Step 1: search ──
      const input = page.getByPlaceholder(/手机号.*WorkFine 顾客编号/)
      await expect(input).toBeVisible()
      await input.fill(MOCK_PHONE)
      await page.getByRole('button', { name: /^搜索$/ }).click()

      // 单一候选会自动进入预览步骤 — Dialog 标题切换到"预览订单 — ..."
      const previewTitle = page.getByText(/预览订单/)
      await expect(previewTitle).toBeVisible({ timeout: 15_000 })

      // 预览表展示 WF-ORD-001 / ¥998.00
      const orderNoCell = page.getByText(MOCK_ORDER_NO).first()
      await expect(orderNoCell).toBeVisible({ timeout: 10_000 })
      await expect(page.getByText('¥998.00').first()).toBeVisible()

      // 该行默认勾选（!alreadyImported && storeMatched）
      // 导入按钮文案：导入选中 1 条
      const importBtn = page.getByRole('button', { name: /导入选中\s*1\s*条/ })
      await expect(importBtn).toBeVisible()
      await importBtn.click()

      // toast 提示"已导入 1 条"
      await expect(page.getByText(/已导入\s*1\s*条/)).toBeVisible({ timeout: 15_000 })

      // URL 跳转到 /legacy-orders?q=13800138000（Dialog 用 ?q= 让列表自动按手机号过滤）
      await page.waitForURL(/\/legacy-orders\?q=13800138000/, { timeout: 15_000 })

      // 验证 DB 落库：sale_orders 多了一条 WF-ORD-001
      const insertedCount = parseInt(
        psql(
          `SELECT COUNT(*)::text FROM sale_orders WHERE sale_order_id = '${MOCK_ORDER_NO}' AND legacy_source = 'workfine' AND status = '未审核'`,
        ),
        10,
      )
      expect(insertedCount).toBe(1)

      // 列表页跳转后应自动按手机号筛选并显示刚导入的订单
      await page.waitForLoadState('networkidle')
      await page.waitForTimeout(1500)
      const body = (await page.textContent('body')) || ''
      expect(body).toContain(MOCK_ORDER_NO)
    } finally {
      await ctx.close()
    }
  })

  test('Test 2: 无 legacy_order:pull 权限的用户（HR）看不到"拉取顾客历史"按钮', async ({
    browser,
  }) => {
    const ctx = await browser.newContext()
    const page = await ctx.newPage()
    try {
      await login(page, TEST_PHONES.HR)

      // HR 角色对 /legacy-orders 页面：
      //   - 无 'legacy_order:list' 权限 → middleware 可能拦截到 /dashboard
      //   - 或页面能进 → canPull=false → 不渲染"拉取顾客历史"按钮
      // 两种结果都满足"HR 无法拉取"的语义。
      const resp = await page.goto(`${BASE}/legacy-orders`, { waitUntil: 'domcontentloaded' })
      await page.waitForLoadState('networkidle').catch(() => null)
      await page.waitForTimeout(1500)

      const status = resp?.status() ?? 0
      const finalUrl = page.url()
      const blockedByMiddleware =
        status === 403 ||
        status === 404 ||
        !finalUrl.includes('/legacy-orders') ||
        /未授权|无权限|权限不足|没有权限|403|404/.test((await page.textContent('body')) || '')

      if (blockedByMiddleware) {
        // 路由层就拦截了，符合"HR 无法访问该入口"的语义，直接 pass
        expect(blockedByMiddleware).toBe(true)
      } else {
        // 页面可进 → 验证按钮不渲染
        const pullBtn = page.getByRole('button', { name: /拉取顾客历史/ })
        await expect(pullBtn).toHaveCount(0)
      }
    } finally {
      await ctx.close()
    }
  })
})
