/**
 * e2e-chains/_helpers/scope-helpers.ts
 *
 * scope 隔离测试的公共助手：
 *   - psql() 同步执行 SQL（5434 fengyu）
 *   - login() 走 /login 表单（admin 密码）
 *   - assertListVisible / assertListEmpty 检查列表页搜索关键字命中情况
 *   - assertSelectOptions 比对下拉框 option 集合
 *
 * 设计原则：
 *   1. UI 探测尽量基于「页面 body 文本是否含关键字 + URL 后缀」，避免对具体 CSS class 强耦合
 *   2. 所有断言函数返回 boolean，结果记录到 verdicts[]，spec 末尾统一 expect
 *   3. 关键字探测使用 sale_order_id / customer name 等显式 fixture，避免假阳性
 */

import { execSync } from 'child_process'
import type { Page } from '@playwright/test'

export const BASE = process.env.ADMIN_BASE_URL || 'http://localhost:3000'
export const ADMIN_PASS = 'fengyu2026'

/** 测试账号（5434 上已 seed） */
export const TEST_PHONES = {
  ADM: '13900139000', // FY-TEST-ADM, admin, 总部
  MGR: '13900139001', // FY-TEST-MGR, manager, 门店 (store-nc01)
  FIN: '13900139002', // FY-TEST-FIN, finance, 总部
  HR: '13900139003', // FY-TEST-HR, hr, 总部
  PRD: '13900139004', // FY-TEST-PRD, product, 总部
  CSM: '13900139005', // FY-TEST-CSM, customer_mgr, 总部
  MKT: '13900139006', // FY-TEST-MKT, manager, 市场 (南昌市场)
  MGR2: '13900139007', // FY-TEST-MGR2, manager, 门店 (store-nc02) ← link-32+
} as const

/** 测试拓扑（5434 已存在） */
export const TOPOLOGY = {
  HQ_ORG_ID: '16d1184b46db099a',
  MARKET_NC: '6707cc8b88579108', // 南昌市场（含 store-nc01 + store-nc02）
  MARKET_NC2: 'ec9ca0f5c96be174', // 南昌市场2（含 b79a82e33d6cf4f3）
  STORE_NC01: 'store-nc01',
  STORE_NC02: 'store-nc02',
  ORG_NC01: 'org-store-nc01',
  ORG_NC02: 'org-store-nc02',
  STORE_OTHER_MARKET: 'b79a82e33d6cf4f3', // 南昌龙珠店（在 MARKET_NC2 下）
} as const

/** scope 相关测试顾客（已 seed） */
export const SCOPE_CLIENTS = {
  NC01: 'FY-FIX-CLIENT-01', // bound_store=store-nc01
  NC02: 'FY-TEST-CLIENT-NC02', // bound_store=store-nc02
  OTHER_MARKET: 'FY-TEST-CLIENT-OM', // bound_store=b79a82e33d6cf4f3
} as const

/** cron 批量测试顾客 */
export const CRON_CLIENTS = ['FY-TEST-CRON-01', 'FY-TEST-CRON-02', 'FY-TEST-CRON-03', 'FY-TEST-CRON-04', 'FY-TEST-CRON-05']

export function psql(sql: string): string {
  try {
    return execSync(
      `PGPASSWORD=fengyu123 psql -h 47.113.202.7 -p 5434 -U fengyu -d fengyu -t -A -c "${sql.replace(/"/g, '\\"')}"`,
      { encoding: 'utf8', timeout: 15000 },
    ).trim()
  } catch (e) {
    const err = e as { message?: string; stderr?: string }
    throw new Error(`psql failed: ${err.message ?? ''}\n${err.stderr ?? ''}`)
  }
}

/**
 * 通用登录 — 走 /login，登录后跳到 /dashboard（或 /change-password）。
 *
 * 健壮性：dev server 单 worker + Turbopack 冷编译 + 多 browser context 并发时，
 * 偶发「提交 → middleware → /dashboard」跳转滞留在 /login（登录竞态，非产品 bug）。
 * 内部用重试包裹：若 waitForURL 超时仍停留 /login，重新 goto /login 重提，最多 3 次，
 * 每次 fill 前清空输入框。签名与调用方零改动（内部增强）。
 *
 * 历史：audit-menu-access.spec.ts 内联验证过此模式（单次 waitForURL 60s 偶发滞留 →
 * 加 3 次重试后稳定），现下沉为共享 helper 标准行为。
 */
export async function login(page: Page, phone: string, pass = ADMIN_PASS): Promise<void> {
  let lastErr: unknown
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      await page.goto(`${BASE}/login`, { waitUntil: 'domcontentloaded' })
      await page.locator('#phone').waitFor({ state: 'visible', timeout: 60_000 })
      // 登录页是 controlled input（onChange → React state），表单提交读 state。
      // dev server 冷编译/高负载时 hydration 慢：若在 onChange 绑定前键入，DOM 有值但
      // React state 仍是 ""，handleSubmit 校验「请输入手机号」直接 return，永远停在 /login。
      // 故：先 networkidle 等 hydration → 用 pressSequentially（逐字真实键事件，hydration
      //     完成后必被 onChange 捕获）填值 → 点登录 → 等 60s 跳转。
      // 若本轮仍因 hydration 未就绪导致「停在 /login」，外层 3 次重试会重新 goto 再来一遍。
      await page.waitForLoadState('networkidle').catch(() => null)
      await page.locator('#phone').click()
      await page.locator('#phone').fill('')
      await page.locator('#phone').pressSequentially(phone, { delay: 30 })
      await page.locator('#password').click()
      await page.locator('#password').fill('')
      await page.locator('#password').pressSequentially(pass, { delay: 30 })
      await page.getByRole('button', { name: /登\s*录/ }).click()
      await page.waitForURL(/\/dashboard|\/change-password/, { timeout: 60_000 })
      return
    } catch (e) {
      lastErr = e
      console.log(`[login] attempt ${attempt} for ${phone} timed out (still on /login?), retrying...`)
    }
  }
  throw lastErr
}

/** 退出登录 — 走 /logout 或 topbar 退出按钮 */
export async function logout(page: Page): Promise<void> {
  await page.goto(`${BASE}/api/logout`).catch(() => null)
  // 退出 API 可能是 POST/重定向；fallback 清 cookie
  await page.context().clearCookies()
}

/**
 * 访问列表页并搜索 keyword，返回是否「至少有一行命中」。
 *
 * 实现细节：
 *   - 访问 listUrl
 *   - 等页面 networkidle + 等到「无数据 / 第 1 页 / 共 X 条」等文案出现
 *   - 用 main innerText（排除 <script>，即 Next.js RSC flight payload 不会污染）
 *
 * 注意：keyword 应当是足够 unique 的字符串（如 sale_order_id、客户姓名）。
 *
 * 历史坑：早期实现用 `page.textContent('body')` 会把 `<script>self.__next_f.push(...)`
 * 里序列化的 URL（含 ?q=keyword）一起算进来 → 即便表格"暂无数据"也会假阳性。
 * innerText 只返回可见文本，绕开 script。
 */
export async function pageContainsKeyword(page: Page, listUrl: string, keyword: string): Promise<boolean> {
  await page.goto(`${BASE}${listUrl}`)
  await page.waitForLoadState('networkidle')
  // 给 RSC streaming + 客户端 hydration 一点时间
  await page.waitForTimeout(1500)
  // main innerText 跳过 <script>，避免 RSC flight payload 里 URL 假阳性
  const main = await page.locator('main').innerText().catch(() => '')
  if (main && main.includes(keyword)) return true
  // fallback：少数页面无 <main>，退回 body 的可见 innerText
  const visible = await page.locator('body').innerText().catch(() => '')
  return Boolean(visible && visible.includes(keyword))
}

/** 试图访问详情页（如 /orders/[id]），断言是否被 scope 拦截（404 / 重定向 / 错误）。 */
export async function detailPageDenied(page: Page, detailUrl: string): Promise<boolean> {
  const resp = await page.goto(`${BASE}${detailUrl}`).catch(() => null)
  await page.waitForLoadState('networkidle').catch(() => null)
  await page.waitForTimeout(800)
  // innerText 排 <script>，避免 RSC flight payload 里 URL 干扰
  const visible = (await page.locator('body').innerText().catch(() => '')) || ''
  // 命中以下任何一种即视为「被拒」：
  //   1) HTTP 404
  //   2) 页面文本包含 "未找到 / 不存在 / 无权 / 找不到"
  //   3) 重定向回 /orders 或 /dashboard 列表（URL 不再含 detail 路径）
  if (resp && resp.status() === 404) return true
  if (/未找到|不存在|无权|无权限|没有权限|找不到|权限不足|404/.test(visible)) return true
  const finalUrl = new URL(page.url())
  if (!finalUrl.pathname.includes(detailUrl.split('?')[0])) return true
  return false
}

/** 读取 <select> 的 option label 列表，去除前后空白 */
export async function getSelectOptionLabels(page: Page, selector: string): Promise<string[]> {
  const labels = await page.locator(`${selector} option`).allTextContents()
  return labels.map((l) => l.trim()).filter(Boolean)
}

/** 通用 verdict 结构 */
export interface Verdict {
  check: string
  verdict: 'PASS' | 'FAIL' | 'SKIP'
  actual?: string | number
}

export function recordVerdict(arr: Verdict[], check: string, ok: boolean, actual?: string | number): void {
  arr.push({ check, verdict: ok ? 'PASS' : 'FAIL', actual })
}

/** 写 .last-test-context.json（用于跨 link 传递 ID，对齐其他 link 的实践） */
export function writeContext(linkKey: string, payload: Record<string, unknown>): void {
  const fs = require('fs') as typeof import('fs')
  const path = require('path') as typeof import('path')
  const CTX = path.resolve(__dirname, '../.last-test-context.json')
  let ctx: Record<string, unknown> = {}
  try {
    ctx = JSON.parse(fs.readFileSync(CTX, 'utf8'))
  } catch {
    /* noop */
  }
  fs.writeFileSync(CTX, JSON.stringify({ ...ctx, [linkKey]: payload }, null, 2))
}

/** 调试用：把 verdicts 打印为 JSON 报告并返回 overall status */
export function summarize(link: number, verdicts: Verdict[], extra: Record<string, unknown> = {}): string {
  const hasFail = verdicts.some((v) => v.verdict === 'FAIL')
  const overall = hasFail ? 'FAIL' : verdicts.some((v) => v.verdict === 'SKIP') ? 'PARTIAL' : 'PASS'
  console.log(`\n[链路${link}] === 最终报告 ===`)
  console.log(JSON.stringify({ link, status: overall, verdicts, ...extra }, null, 2))
  return overall
}
