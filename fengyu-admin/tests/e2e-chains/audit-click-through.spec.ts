/**
 * 点击穿透 audit：list page → 详情/编辑/分配 按钮 → 落地页可达
 *
 * 与 `_audit-403.spec.ts` 互补：
 *   - URL 直访层：每个角色访问 menu 显示的页面，确保 GET 200 + 无 ErrorBoundary
 *   - 点击穿透层（本 spec）：列表里的"详情/编辑"按钮点击后，落地页必须可达
 *
 * 漏检场景：
 *   1. 按钮 href 拼错（指向死链）
 *   2. 落地页内部辅助数据 getXxx() 缺权限 → ErrorBoundary
 *   3. 落地页本身 require 不在该角色权限内
 *
 * 注：只验"点击导致 URL 跳转"的元素；dialog 类（"分配顾问"、"新增顾客"）跳过，由
 *     link-19 / 业务链路覆盖。
 */
import { test } from '@playwright/test'
import { BASE, TEST_PHONES } from './_helpers/scope-helpers'

test.setTimeout(900_000)

// 列表页 → (行内导航按钮 selector, 顶部操作按钮)
// 行内 selector 必须返回真实跳转链接（table 内带 href 的 <a>）
type ListConfig = {
  list: string
  rowLinkSelector: string // 行内"详情/编辑"按钮的 Playwright selector
  topActions: Array<{ name: string; href: string }>
}

const LISTS: ListConfig[] = [
  {
    list: '/customers',
    rowLinkSelector: 'table a:has-text("详情")',
    topActions: [], // "新增顾客" 是 dialog，跳过
  },
  {
    list: '/orders',
    // /orders 的"详情"链接挂在订单号上（class="text-[var(--primary)]"）
    rowLinkSelector: 'table a[href^="/orders/"]',
    topActions: [
      { name: '新建订单', href: '/orders/create' },
      { name: '开寄存单', href: '/orders/create-deposit' },
    ],
  },
  {
    list: '/services',
    rowLinkSelector: 'table a[href^="/services/"]',
    topActions: [{ name: '新建服务单', href: '/services/create' }],
  },
  {
    list: '/employees',
    rowLinkSelector: 'table a:has-text("详情")',
    topActions: [{ name: '新增员工', href: '/employees/create' }],
  },
  {
    list: '/stores',
    rowLinkSelector: 'table a:has-text("编辑")',
    topActions: [{ name: '新增门店', href: '/stores/create' }],
  },
  {
    list: '/products',
    rowLinkSelector: 'table a:has-text("详情")',
    topActions: [
      { name: '新增 SKU', href: '/products/create' },
      { name: '商品分类', href: '/products/categories' },
    ],
  },
  {
    list: '/allocations',
    // /allocations 行内有"详情"按钮跳 /allocations/[orderId] 或 /allocations/service/[id]
    rowLinkSelector: 'table a[href^="/allocations/"]',
    topActions: [],
  },
  {
    list: '/coupons',
    rowLinkSelector: 'table a[href^="/coupons/"]',
    topActions: [{ name: '新建', href: '/coupons/create' }],
  },
  {
    list: '/mall',
    rowLinkSelector: 'table a[href^="/mall/"]',
    topActions: [
      { name: '新建', href: '/mall/create' },
      { name: '商品分类', href: '/mall/categories' },
    ],
  },
  {
    list: '/cards',
    // /cards 行内跳顾客详情（卡持有人）
    rowLinkSelector: 'table a[href^="/customers/"]',
    topActions: [],
  },
]

// 角色 → 应能打开的列表页
const ROLE_LISTS: Record<string, string[]> = {
  admin: ['/employees', '/stores', '/products', '/coupons', '/mall'],
  manager: ['/customers', '/orders', '/services', '/allocations', '/cards'],
  finance: ['/customers', '/orders', '/allocations', '/cards'], // 全是 readonly，但按钮应该都存在
  hr: ['/employees', '/stores'],
  product: ['/products', '/coupons', '/mall'],
  customer_mgr: ['/customers', '/cards'],
}

const PHONE: Record<string, string> = {
  admin: TEST_PHONES.ADM,
  manager: TEST_PHONES.MGR,
  finance: TEST_PHONES.FIN,
  hr: TEST_PHONES.HR,
  product: TEST_PHONES.PRD,
  customer_mgr: TEST_PHONES.CSM,
}

async function loginSlow(page: import('@playwright/test').Page, phone: string): Promise<void> {
  await page.goto(`${BASE}/login`, { waitUntil: 'domcontentloaded' })
  await page.locator('#phone').waitFor({ state: 'attached', timeout: 60_000 })
  await page.locator('#phone').click()
  await page.locator('#phone').pressSequentially(phone, { delay: 30 })
  await page.locator('#password').click()
  await page.locator('#password').pressSequentially('fengyu2026', { delay: 30 })
  await page.getByRole('button', { name: /登\s*录/ }).click()
  await page.waitForURL(/\/dashboard|\/change-password/, { timeout: 60_000 })
}

type ProbeResult = {
  role: string
  type: 'row' | 'top'
  list: string
  action: string
  landing: string
  badge: '✅' | '⏭️' | '❌'
  detail: string
}

async function clickRowLink(
  page: import('@playwright/test').Page,
  cfg: ListConfig,
): Promise<{ landing: string; badge: '✅' | '⏭️' | '❌'; detail: string }> {
  await page.goto(`${BASE}${cfg.list}`, { waitUntil: 'domcontentloaded' })
  await page.waitForTimeout(1500)
  // 抓"行内导航按钮"
  const link = page.locator(cfg.rowLinkSelector).first()
  const cnt = await link.count()
  if (cnt === 0) {
    return { landing: '', badge: '⏭️', detail: '无行内按钮（list 可能空数据）' }
  }
  const before = page.url()
  // 用 newURL 而非 click 跳转（避免 Link prefetch 干扰）— 拿到 href 后 goto
  const href = await link.getAttribute('href')
  if (!href) return { landing: '', badge: '❌', detail: '行内按钮无 href' }
  const resp = await page.goto(`${BASE}${href}`, { waitUntil: 'domcontentloaded' }).catch(() => null)
  await page.waitForTimeout(1000)
  const after = page.url()
  if (after === before) return { landing: after, badge: '❌', detail: 'URL 未跳转' }
  const body = (await page.textContent('body').catch(() => '')) || ''
  const errorBoundary = body.includes('服务异常') && body.includes('错误编号:')
  const permDenied = /无权执行|无权限|没有权限|权限不足|访问受限/.test(body)
  if (resp && resp.status() === 404) return { landing: href, badge: '❌', detail: 'status=404 死链' }
  if (errorBoundary) return { landing: href, badge: '❌', detail: 'ErrorBoundary' }
  if (permDenied) return { landing: href, badge: '❌', detail: 'permDenied' }
  return { landing: href, badge: '✅', detail: 'OK' }
}

async function checkTopAction(
  page: import('@playwright/test').Page,
  cfg: ListConfig,
  action: { name: string; href: string },
): Promise<{ badge: '✅' | '⏭️' | '❌'; detail: string }> {
  await page.goto(`${BASE}${cfg.list}`, { waitUntil: 'domcontentloaded' })
  await page.waitForTimeout(800)
  // 用 href 选择器，避开文案差异（更稳）
  const link = page.locator(`a[href="${action.href}"]`).first()
  if ((await link.count()) === 0) {
    return { badge: '⏭️', detail: `顶部按钮不可见（该角色可能不应有）` }
  }
  // 按钮存在 → 直接 goto href 验证落地
  const resp = await page.goto(`${BASE}${action.href}`, { waitUntil: 'domcontentloaded' }).catch(() => null)
  await page.waitForTimeout(1000)
  const body = (await page.textContent('body').catch(() => '')) || ''
  if (resp && resp.status() === 404) return { badge: '❌', detail: 'status=404 死链' }
  if (body.includes('服务异常') && body.includes('错误编号:')) return { badge: '❌', detail: 'ErrorBoundary' }
  if (/无权执行|无权限|没有权限|权限不足|访问受限/.test(body)) return { badge: '❌', detail: 'permDenied' }
  return { badge: '✅', detail: 'OK' }
}

test('audit-click：list 行内按钮 + 顶部操作按钮点击穿透', async ({ browser }) => {
  const results: ProbeResult[] = []

  for (const role of Object.keys(ROLE_LISTS)) {
    console.log(`\n────────── ${role} ──────────`)
    const ctx = await browser.newContext()
    const page = await ctx.newPage()
    try {
      await loginSlow(page, PHONE[role])
      for (const listPath of ROLE_LISTS[role]) {
        const cfg = LISTS.find((c) => c.list === listPath)
        if (!cfg) continue

        // (1) 行内按钮
        const rowResult = await clickRowLink(page, cfg)
        const rowAction = cfg.rowLinkSelector.includes('详情') ? '行内 详情' :
                          cfg.rowLinkSelector.includes('编辑') ? '行内 编辑' :
                          '行内 跳转链接'
        results.push({
          role, type: 'row', list: listPath, action: rowAction,
          landing: rowResult.landing, badge: rowResult.badge, detail: rowResult.detail,
        })
        console.log(`  ${rowResult.badge} [row]  ${listPath.padEnd(20)} → ${rowResult.landing.padEnd(45)} ${rowResult.detail}`)

        // (2) 顶部操作按钮
        for (const action of cfg.topActions) {
          const r = await checkTopAction(page, cfg, action)
          results.push({
            role, type: 'top', list: listPath, action: action.name,
            landing: action.href, badge: r.badge, detail: r.detail,
          })
          console.log(`  ${r.badge} [top]  ${listPath.padEnd(20)} → ${action.href.padEnd(45)} (${action.name}) ${r.detail}`)
        }
      }
    } finally {
      await ctx.close()
    }
  }

  console.log('\n────────── SUMMARY ──────────')
  const fails = results.filter((r) => r.badge === '❌')
  const skips = results.filter((r) => r.badge === '⏭️')
  const pass = results.filter((r) => r.badge === '✅')
  console.log(`Total=${results.length}, Pass=${pass.length}, Fail=${fails.length}, Skip=${skips.length}`)
  if (fails.length) {
    console.log('\nFailing:')
    for (const f of fails) {
      console.log(`  ${f.role.padEnd(15)} [${f.type}] ${f.list.padEnd(20)} ${f.action.padEnd(15)} → ${f.landing}  ${f.detail}`)
    }
  }
  if (skips.length) {
    console.log('\nSkipped (按钮不可见，可能正常也可能漏配置):')
    for (const s of skips) {
      console.log(`  ${s.role.padEnd(15)} [${s.type}] ${s.list.padEnd(20)} ${s.action.padEnd(15)} ${s.detail}`)
    }
  }
})
