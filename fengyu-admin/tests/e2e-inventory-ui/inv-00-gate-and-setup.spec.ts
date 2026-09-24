/**
 * INV-00：期初门禁与环境自检
 *
 * 目的：确认本套件的运行地基成立 —— 目标库正确、4 个测试账号可登录、
 * 11 个库存页面对超管可达、期初门禁状态已知。
 *
 * 为什么门禁的负向断言不在这里：建单弹窗强制要选库存 SKU，而 dev 库
 * 初始 0 个 SKU，关闸态下压根填不完表单。且主数据 CRUD（createInventorySku /
 * createInventorySupplier / ...）**不在** assertInventoryBusinessWritable 的调用点
 * （engine.ts 只在 2677/2839/2905/2950 = createDoc/approve/reject/receive 上守门），
 * 所以建档可以在关闸态完成。门禁负向断言因此下沉到 INV-02 —— 那时已有 SKU 可选。
 *
 * 预条件：dev admin 站点可访问；psql 可连 101.34.242.103:5433/fengyu_wxapp。
 */

import { test, expect } from '@playwright/test'
import {
  BASE,
  INVT_ACCOUNTS,
  INVT_PASS,
  assertTargetDb,
  login,
  psql,
  recordVerdict,
  summarize,
  writeCtx,
  type Verdict,
} from './_helpers/env'
import { seedInventoryAccounts, verifyInventoryAccounts, closeSeedPool } from './_helpers/seed-accounts'
import { readCutoverStatus } from './_helpers/cutover'

test.setTimeout(300_000)

/** 库存管理全部 11 个路由（src/app/(main)/(inventory)/inventory/） */
const INVENTORY_ROUTES = [
  { path: '/inventory/stocks', heading: /实时库存|库存查询|库存/ },
  { path: '/inventory/docs', heading: /单据|库存单据/ },
  { path: '/inventory/operations/supply-chain', heading: /供应链|需求与采购/ },
  { path: '/inventory/operations/market', heading: /市场|需求与采购/ },
  { path: '/inventory/operations/store', heading: /门店|需求与采购/ },
  { path: '/inventory/settlements', heading: /结算|货款/ },
  { path: '/inventory/skus', heading: /商品|资料/ },
  { path: '/inventory/suppliers', heading: /供应商|资料/ },
  { path: '/inventory/sku-mappings', heading: /组成|资料/ },
  { path: '/inventory/promotions', heading: /福利|方案|资料/ },
] as const

test('INV-00：环境自检 —— 目标库 / 账号 / 页面可达 / 门禁状态', async ({ browser }) => {
  const verdicts: Verdict[] = []

  try {
    // ── Step 1: 守护目标库，绝不误连生产 ────────────────────────────
    console.log('[INV-00] Step 1: 校验目标库')
    assertTargetDb()
    const dbInfo = psql(`SELECT current_database() || '@' || COALESCE(inet_server_addr()::text, 'local')`)
    recordVerdict(verdicts, 'db: 目标库是 dev fengyu_wxapp', dbInfo.startsWith('fengyu_wxapp@'), dbInfo)

    // ── Step 2: seed 全部测试账号（幂等）───────────────────────────
    console.log('[INV-00] Step 2: seed 测试账号')
    const seeded = await seedInventoryAccounts()
    const expectedSeeds = Object.keys(INVT_ACCOUNTS).length
    recordVerdict(verdicts, `seed: ${expectedSeeds} 个账号已就位`, seeded.length === expectedSeeds, `count=${seeded.length}`)

    const verified = await verifyInventoryAccounts()
    const byId = new Map(verified.map((r) => [r.employeeId, r]))

    for (const acct of Object.values(INVT_ACCOUNTS)) {
      const row = byId.get(acct.employeeId)
      recordVerdict(
        verdicts,
        `seed: ${acct.employeeId} 角色绑定 = ${acct.role}`,
        row?.role === acct.role,
        row?.role ?? 'missing',
      )
      recordVerdict(
        verdicts,
        `seed: ${acct.employeeId} scope = ${acct.scopeId}`,
        row?.scopeId === acct.scopeId,
        row?.scopeId ?? 'missing',
      )
      recordVerdict(verdicts, `seed: ${acct.employeeId} 有密码`, row?.hasPassword === true, String(row?.hasPassword))
    }

    // scope 类型必须与角色 allowed_scope_types 匹配（DB 触发器已校验，这里复核落库结果）
    recordVerdict(verdicts, 'seed: 供应链账号 scope 类型 = 总部', byId.get('INVT-SC-01')?.scopeType === '总部', byId.get('INVT-SC-01')?.scopeType ?? '?')
    recordVerdict(verdicts, 'seed: 市场账号 scope 类型 = 市场', byId.get('INVT-MK-01')?.scopeType === '市场', byId.get('INVT-MK-01')?.scopeType ?? '?')
    recordVerdict(verdicts, 'seed: 自贡市场账号 scope 类型 = 市场', byId.get('INVT-MK-02')?.scopeType === '市场', byId.get('INVT-MK-02')?.scopeType ?? '?')
    recordVerdict(verdicts, 'seed: 门店账号 scope 类型 = 门店', byId.get('INVT-ST-01')?.scopeType === '门店', byId.get('INVT-ST-01')?.scopeType ?? '?')

    // 门店库存员禁止登录 admin —— migration 0039 的硬约束，INV-08 会实测
    recordVerdict(
      verdicts,
      'seed: 门店库存员 can_access_admin = false（0039 硬约束）',
      byId.get('INVT-ST-01')?.canAccessAdmin === false,
      String(byId.get('INVT-ST-01')?.canAccessAdmin),
    )

    // ── Step 3: 超管登录 ──────────────────────────────────────────
    console.log('[INV-00] Step 3: 超管登录')
    const ctx = await browser.newContext()
    const page = await ctx.newPage()
    page.on('console', (m) => { if (m.type() === 'error') console.log(`[browser-err] ${m.text()}`) })

    await login(page, INVT_ACCOUNTS.ADM.phone, INVT_PASS)
    const landedUrl = page.url()
    recordVerdict(
      verdicts,
      'login: 超管落地 /dashboard（未被 must_change 拦到改密页）',
      landedUrl.includes('/dashboard'),
      landedUrl,
    )

    // ── Step 4: 11 个库存路由可达性 ────────────────────────────────
    console.log('[INV-00] Step 4: 库存页面可达性')
    for (const route of INVENTORY_ROUTES) {
      const resp = await page.goto(`${BASE}${route.path}`, { waitUntil: 'domcontentloaded' }).catch(() => null)
      await page.waitForLoadState('networkidle').catch(() => null)
      await page.waitForTimeout(600)
      const status = resp?.status() ?? 0
      const body = (await page.locator('body').innerText().catch(() => '')) || ''
      // 可达判定只认强信号：业务文案里「未配置」「不存在」之类太常见，
      // 早期用宽正则会把 /inventory/sku-mappings 的「未配置」列值误判成被拦截。
      const blockMatch = body.match(/权限不足|没有权限|无权访问|PERMISSION_DENIED|Application error|Internal Server Error|此页面找不到|404 This page/)
      const blocked = Boolean(blockMatch)
      recordVerdict(
        verdicts,
        `route: ${route.path} 对超管可达`,
        status > 0 && status < 400 && !blocked,
        `status=${status}${blocked ? ` blocked:「${blockMatch![0]}」` : ''}`,
      )
    }

    // /inventory 根路由是重定向，单独断言落点
    await page.goto(`${BASE}/inventory`, { waitUntil: 'domcontentloaded' }).catch(() => null)
    await page.waitForLoadState('networkidle').catch(() => null)
    const rootLanded = page.url()
    recordVerdict(
      verdicts,
      'route: /inventory 重定向到默认办理台',
      /\/inventory\/(operations|stocks|docs)/.test(rootLanded),
      rootLanded,
    )

    // ── Step 5: 期初门禁状态（只读，不改）────────────────────────
    console.log('[INV-00] Step 5: 读取期初门禁状态')
    const gate = readCutoverStatus()
    console.log(`[INV-00] 期初门禁当前状态 = ${gate}`)
    recordVerdict(verdicts, 'gate: 门禁状态可读', ['待初始化', '待核验', '已初始化'].includes(gate), gate)

    // ── Step 6: 库存域基线计数（供后续 spec 做增量断言）────────────
    const baseline = {
      skus: Number(psql(`SELECT count(*) FROM inventory_skus`)),
      suppliers: Number(psql(`SELECT count(*) FROM inventory_suppliers`)),
      docs: Number(psql(`SELECT count(*) FROM inventory_docs`)),
      lots: Number(psql(`SELECT count(*) FROM inventory_stock_lots`)),
      movements: Number(psql(`SELECT count(*) FROM inventory_movements`)),
    }
    console.log('[INV-00] 库存域基线:', JSON.stringify(baseline))
    writeCtx('inv00', { gateAtStart: gate, baseline })

    await ctx.close()
  } finally {
    await closeSeedPool()
    summarize(0, verdicts)
  }

  const failures = verdicts.filter((v) => v.verdict === 'FAIL')
  expect(failures, `INV-00 失败项:\n${JSON.stringify(failures, null, 2)}`).toHaveLength(0)
})
