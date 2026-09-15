/**
 * e2e-inventory-ui/_helpers/env.ts
 *
 * 库存 UI 链路的环境常量与基础工具。
 *
 * 设计取舍：
 *   - `psql` / `login` / `recordVerdict` / `summarize` 直接复用 e2e-chains 的实现，
 *     不再造一份。前者已硬编码 101.34.242.103:5433/fengyu_wxapp（正是本套件目标库）
 *     并带网络抖动重试；后者已处理受控组件 hydration 竞态（pressSequentially + 3 次重试）。
 *     ⚠️ 若 e2e-chains 的 psql 改了库地址，本套件会跟着漂 —— 见 assertTargetDb()。
 *   - 账号常量**不**复用 e2e-chains 的 TEST_PHONES：那套 FY-TEST-* 是别的库的 seed，
 *     dev 库里不存在。本套件自建 INVT-* 账号（见 seed-accounts.ts）。
 */

import type { Page } from '@playwright/test'
import { psql, recordVerdict, summarize, type Verdict } from '../../e2e-chains/_helpers/scope-helpers'

export { psql, recordVerdict, summarize }
export type { Verdict }

/** admin 站点地址。默认指向 dev 部署实例而非 localhost —— 本套件测的就是它。 */
export const BASE = process.env.ADMIN_BASE_URL || 'http://101.34.242.103:3000'

/** 测试账号统一密码。仅 dev 环境测试账号，不对应任何真实人员。 */
export const INVT_PASS = 'Invt@2026'

/** 测试账号（由 seed-accounts.ts 幂等创建） */
export const INVT_ACCOUNTS = {
  /** 超管：主链路驱动。scope 不受限、价格档 all */
  ADM: { employeeId: 'INVT-ADM-01', phone: '19900001001', name: 'INVT-超管', role: 'admin', scopeId: 'ORG-HQ' },
  /** 供应链库存员：只能绑总部 */
  SC: { employeeId: 'INVT-SC-01', phone: '19900001002', name: 'INVT-供应链', role: 'inventory_supply_chain_operator', scopeId: 'ORG-HQ' },
  /** 市场库存财务：只能绑市场 */
  MK: { employeeId: 'INVT-MK-01', phone: '19900001003', name: 'INVT-市场财务', role: 'inventory_market_finance', scopeId: 'org-市场-1779327286268' },
  /** 门店库存员：can_access_admin=false，仅用于断言无法登录 admin */
  ST: { employeeId: 'INVT-ST-01', phone: '19900001004', name: 'INVT-门店员', role: 'inventory_store_operator', scopeId: 'org-门店-1780295730424' },
} as const

/** dev 库真实组织拓扑（2026-09-13 核实） */
export const TOPO = {
  HQ: 'ORG-HQ',
  /** 南昌凤御，下辖 18 店 —— 测试主场 */
  MARKET: 'org-市场-1779327286268',
  MARKET_NAME: '南昌凤御',
  /** 自贡凤御 —— 跨市场负向断言用 */
  MARKET_OTHER: 'org-市场-1779767525664',
  MARKET_OTHER_NAME: '自贡凤御',
  /** 南昌万科店 */
  STORE_A_ORG: 'org-门店-1780295730424',
  STORE_A_ID: 'store-1780299019315',
  STORE_A_NAME: '南昌万科店',
  /** 南昌世纪店 */
  STORE_B_ORG: 'org-门店-1779327399972',
  STORE_B_ID: 'store-1779809954402',
  STORE_B_NAME: '南昌世纪店',
} as const

/** 所有测试数据的命名空间前缀。inventory_movements 只追加，留痕靠前缀识别。 */
export const NS = 'INVT'

/**
 * 参数化查询用的连接串（与 e2e-chains 的 psql helper 同库同凭据）。
 *
 * 为什么需要它：psql helper 走 `execSync('... -c "SQL"')`，SQL 里的 `$` 会被 shell
 * 展开。bcrypt hash 形如 `$2b$12$...`，用 psql 传会被截成乱码 —— 所以凡是带 `$` 的
 * 值一律走 pg 参数化（见 seed-accounts.ts）。
 */
export const PG_URL = process.env.INVT_DATABASE_URL
  || 'postgresql://fengyu:fengyu123@101.34.242.103:5433/fengyu_wxapp'

/** SQL 字面量转义（helpers 里手拼 SQL 时用，避免单引号截断） */
export const sqlStr = (value: string): string => `'${value.replace(/'/g, "''")}'`

/**
 * 守护：确认 psql 确实连到 dev 库而非其他环境。
 * 生产库是 118.178.196.26 —— 误连即刻中止，库存流水删不掉。
 */
export function assertTargetDb(): void {
  const db = psql(`SELECT current_database() || '@' || inet_server_addr()`)
  if (!db.startsWith('fengyu_wxapp@')) {
    throw new Error(`[env] 目标库不是 fengyu_wxapp，实际 = ${db}；中止以免污染其他环境`)
  }
  if (db.includes('118.178.196.26')) {
    throw new Error('[env] 检测到生产库地址，立即中止')
  }
}

/** 跨 spec 传递单据号等上下文 */
const CTX_FILE = 'tests/e2e-inventory-ui/.last-inventory-context.json'

export function writeCtx(key: string, payload: Record<string, unknown>): void {
  const fs = require('fs') as typeof import('fs')
  let ctx: Record<string, unknown> = {}
  try {
    ctx = JSON.parse(fs.readFileSync(CTX_FILE, 'utf8'))
  } catch {
    /* 首次运行无文件 */
  }
  fs.writeFileSync(CTX_FILE, JSON.stringify({ ...ctx, [key]: payload }, null, 2))
}

export function readCtx<T = Record<string, unknown>>(key: string): T | null {
  const fs = require('fs') as typeof import('fs')
  try {
    const ctx = JSON.parse(fs.readFileSync(CTX_FILE, 'utf8'))
    return (ctx[key] as T) ?? null
  } catch {
    return null
  }
}

/**
 * 登录 admin。
 *
 * 为什么不复用 e2e-chains 的 login()：那个函数闭包引用它自己模块里的 BASE
 * （默认 localhost:3000），import 提升会让它先于本模块求值，设 process.env 也来不及。
 * 本套件目标是远程 dev 实例，必须用自己的 BASE。
 *
 * 重试逻辑照搬 scope-helpers.ts:92-120 的实战经验：登录页是受控组件，
 * hydration 未完成时 fill() 只改 DOM 不触发 onChange，handleSubmit 读到空 state
 * 直接 return，页面永远停在 /login。故先等 networkidle，再用 pressSequentially
 * 逐字触发真实键事件；仍失败则整轮重来，最多 3 次。
 */
export async function login(page: Page, phone: string, pass: string): Promise<void> {
  let lastErr: unknown
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      await page.goto(`${BASE}/login`, { waitUntil: 'domcontentloaded' })
      await page.locator('#phone').waitFor({ state: 'visible', timeout: 60_000 })
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
      console.log(`[login] attempt ${attempt} for ${phone} 未跳转，重试...`)
    }
  }
  throw lastErr
}

/**
 * 尝试登录并返回结果，不抛异常。
 * 用于 INV-08 断言「门店库存员无法登录 admin」这类**期望失败**的场景。
 */
export async function tryLogin(
  page: Page,
  phone: string,
  pass: string,
): Promise<{ ok: boolean; url: string; message: string }> {
  await page.goto(`${BASE}/login`, { waitUntil: 'domcontentloaded' })
  await page.locator('#phone').waitFor({ state: 'visible', timeout: 60_000 })
  await page.waitForLoadState('networkidle').catch(() => null)
  await page.locator('#phone').click()
  await page.locator('#phone').pressSequentially(phone, { delay: 30 })
  await page.locator('#password').click()
  await page.locator('#password').pressSequentially(pass, { delay: 30 })
  await page.getByRole('button', { name: /登\s*录/ }).click()
  const ok = await page
    .waitForURL(/\/dashboard|\/change-password/, { timeout: 20_000 })
    .then(() => true)
    .catch(() => false)
  const message = (await page.locator('body').innerText().catch(() => '')) || ''
  return { ok, url: page.url(), message }
}

/** 今天（Asia/Shanghai），与 operations 页面的 today() 同口径 */
export function today(): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date())
}
