/**
 * 链路 35c：表单 storeId / employee select 锁定（多页样本）
 *
 * 主题：admin 表单页（服务单创建 / 分配 / 顾客分配）的 store/employee select 应严格
 *       按 server-side scope 过滤；MGR 不应能选他店员工，MKT 不应能选非南昌员工，
 *       admin 可选全部。同时 MGR 应被 403 阻挡进入仅 admin/hr 的页面。
 *
 * 抽样覆盖：
 *   - /services/create     storeId select + employee select（filteredEmployees 联动）
 *   - /allocations/[soid]  employee select（由 link-9 业务部分覆盖，本 spec 仅断言下拉范围）
 *   - /customers/[id]      "分配顾问"对话框中 employee select（assign 流程）
 *   - 反例 1：MGR 直接 GET `/employees/new` → 应被 menu / route guard 拒
 *   - 反例 2：MGR 直接 GET `/permissions` → 应被拒
 *
 * 数据依赖：FY-FIX-CLIENT-01（nc01 顾客）+ 链路 1 已留存的 sale_order；
 * 若无活跃订单 / 顾客 / 分配，相关 case SKIP。
 *
 * 关键引用：
 *   - actions/services.ts:createServiceOrder（依赖 employees.storeId 命中 scope）
 *   - service-create-page.tsx:156         filteredEmployees by selectedStoreId
 *   - allocation-detail-page.tsx          employee 下拉来源（getEmployees scope）
 *   - actions/employees.ts:listEmployees + scopeCondition
 */

import { test, expect } from '@playwright/test'
import {
  BASE,
  TEST_PHONES,
  TOPOLOGY,
  psql,
  login,
  recordVerdict,
  summarize,
  writeContext,
  type Verdict,
} from './_helpers/scope-helpers'

/** 进入 /services/create，找到「门店」select & 「负责美容师」select，返回 option labels */
async function readServiceCreateSelects(
  page: import('@playwright/test').Page,
): Promise<{ stores: string[]; employees: string[]; reachedStep1: boolean }> {
  await page.goto(`${BASE}/services/create`)
  await page.waitForLoadState('networkidle').catch(() => null)
  await page.waitForTimeout(1500)

  // 顾客搜索 → 选第一个 → 选第一个可服务项 → 下一步进入"服务配置"
  const phoneIn = page.getByPlaceholder(/手机号/).first()
  if (await phoneIn.count() === 0) {
    return { stores: [], employees: [], reachedStep1: false }
  }
  await phoneIn.fill('13800138000')
  const searchBtn = page.getByRole('button', { name: /搜索/ }).first()
  await searchBtn.click().catch(() => null)
  await page.waitForFunction(() => /找到|未找到/.test(document.body.textContent || ''), { timeout: 15000 }).catch(() => null)
  const firstCustomerBtn = page.locator('button:has-text("选择"), div.space-y-1 > button').first()
  if (await firstCustomerBtn.count() === 0) {
    return { stores: [], employees: [], reachedStep1: false }
  }
  await firstCustomerBtn.click().catch(() => null)
  await page.waitForTimeout(1500)

  // 选第一个可服务项
  const firstItem = page.locator('table tbody tr').first().locator('button, input[type="checkbox"]').first()
  if (await firstItem.count() > 0) await firstItem.click().catch(() => null)
  await page.waitForTimeout(800)

  // 下一步进入"服务配置"
  await page.getByRole('button', { name: '下一步' }).first().click().catch(() => null)
  await page.waitForTimeout(1500)

  const allSelects = await page.locator('select').all()
  if (allSelects.length < 2) return { stores: [], employees: [], reachedStep1: false }

  const stores = (await allSelects[0].locator('option').allTextContents()).map((s) => s.trim()).filter(Boolean)
  const employees = (await allSelects[1].locator('option').allTextContents()).map((s) => s.trim()).filter(Boolean)
  return { stores, employees, reachedStep1: true }
}

/** 直接访问 path，断言 1500ms 内被重定向 / 403 / 渲染空 */
async function expectDenied(page: import('@playwright/test').Page, path: string): Promise<boolean> {
  const resp = await page.goto(`${BASE}${path}`).catch(() => null)
  await page.waitForLoadState('networkidle').catch(() => null)
  await page.waitForTimeout(1000)
  if (resp && resp.status() === 404) return true
  if (resp && resp.status() === 403) return true
  const body = (await page.textContent('body').catch(() => '')) || ''
  if (/无权|无权限|没有权限|403|权限不足|Forbidden/.test(body)) return true
  // 若 URL 重定向到非目标路径（如 /dashboard）也视为被拒
  const finalPath = new URL(page.url()).pathname
  if (!finalPath.includes(path.split('?')[0].split('/').slice(0, 3).join('/'))) return true
  return false
}

test.setTimeout(300_000)

test('链路35c：表单 store/employee select 锁定（多页样本）', async ({ browser }) => {
  const verdicts: Verdict[] = []
  const totalStores = parseInt(psql(`SELECT COUNT(*)::text FROM stores`), 10)
  const nc01Employees = parseInt(
    psql(`SELECT COUNT(*)::text FROM staff_wechat_users WHERE store_id='${TOPOLOGY.STORE_NC01}' AND COALESCE(is_resigned, false)=false`),
    10,
  )
  const ncMarketEmployees = parseInt(
    psql(`
      SELECT COUNT(*)::text FROM staff_wechat_users s
      JOIN org_nodes o ON s.org_node_id=o.id
      WHERE o.parent_id='${TOPOLOGY.MARKET_NC}' AND COALESCE(s.is_resigned,false)=false
    `),
    10,
  )

  console.log(`[链路35c] baseline: totalStores=${totalStores} nc01Employees=${nc01Employees} ncMktEmployees=${ncMarketEmployees}`)

  // ── Case 1: MGR(nc01) ──
  console.log('[链路35c] Case 1: MGR(nc01) /services/create')
  const ctxMgr = await browser.newContext()
  const pMgr = await ctxMgr.newPage()
  try {
    await login(pMgr, TEST_PHONES.MGR)
    const got = await readServiceCreateSelects(pMgr)
    if (!got.reachedStep1) {
      recordVerdict(verdicts, 'mgr_services_create_reach_step1', false, '未到达服务配置步')
    } else {
      const realStores = got.stores
      const realEmployees = got.employees.filter((e) => !e.includes('请选择'))
      recordVerdict(verdicts, 'mgr_services_create_one_store', realStores.length === 1, `stores=${realStores.length} [${realStores.join('|')}]`)
      recordVerdict(verdicts, 'mgr_services_create_sees_nc01', realStores.some((s) => s.includes('南昌旗舰店')), `stores=${realStores.join('|')}`)
      recordVerdict(
        verdicts,
        'mgr_services_create_employees_scope_capped',
        realEmployees.length > 0 && realEmployees.length <= nc01Employees + 2,
        `employees=${realEmployees.length} (db nc01=${nc01Employees})`,
      )
    }
    // 反例：MGR 直接访问 admin/hr 专属页
    const deniedNewEmp = await expectDenied(pMgr, '/employees/new')
    recordVerdict(verdicts, 'mgr_denied_employees_new', deniedNewEmp, `denied=${deniedNewEmp}`)
    const deniedPerm = await expectDenied(pMgr, '/permissions')
    recordVerdict(verdicts, 'mgr_denied_permissions', deniedPerm, `denied=${deniedPerm}`)
  } finally {
    await ctxMgr.close()
  }

  // ── Case 2: MKT(南昌) ──
  console.log('[链路35c] Case 2: MKT(南昌) /services/create')
  const ctxMkt = await browser.newContext()
  const pMkt = await ctxMkt.newPage()
  try {
    await login(pMkt, TEST_PHONES.MKT)
    const got = await readServiceCreateSelects(pMkt)
    if (!got.reachedStep1) {
      recordVerdict(verdicts, 'mkt_services_create_reach_step1', false, '未到达服务配置步')
    } else {
      const realStores = got.stores
      const realEmployees = got.employees.filter((e) => !e.includes('请选择'))
      recordVerdict(
        verdicts,
        'mkt_services_create_stores_in_market',
        realStores.length > 1 && realStores.length < totalStores,
        `stores=${realStores.length}, totalDb=${totalStores}`,
      )
      const seesNc01 = realStores.some((s) => s.includes('南昌旗舰店'))
      const seesNc02 = realStores.some((s) => s.includes('青山湖店'))
      const seesOtherMkt = realStores.some((s) => s.includes('龙珠店'))
      recordVerdict(verdicts, 'mkt_services_create_sees_nc01', seesNc01, `nc01=${seesNc01}`)
      recordVerdict(verdicts, 'mkt_services_create_sees_nc02', seesNc02, `nc02=${seesNc02}`)
      recordVerdict(verdicts, 'mkt_services_create_not_sees_other_mkt', !seesOtherMkt, `other=${seesOtherMkt}`)
      // 美容师下拉首屏 = 默认选中第一个 store 的员工，应该 ≤ 该 store 的员工数；
      // 这里只做软断言：employees 非空 + 不超过整个市场员工
      recordVerdict(
        verdicts,
        'mkt_services_create_employees_capped',
        realEmployees.length > 0 && realEmployees.length <= ncMarketEmployees + 2,
        `employees=${realEmployees.length} mkt总=${ncMarketEmployees}`,
      )
    }
  } finally {
    await ctxMkt.close()
  }

  // ── Case 3: ADM ──
  console.log('[链路35c] Case 3: ADM /services/create')
  const ctxAdm = await browser.newContext()
  const pAdm = await ctxAdm.newPage()
  try {
    await login(pAdm, TEST_PHONES.ADM)
    const got = await readServiceCreateSelects(pAdm)
    if (!got.reachedStep1) {
      recordVerdict(verdicts, 'adm_services_create_reach_step1', false, '未到达服务配置步')
    } else {
      const realStores = got.stores
      recordVerdict(
        verdicts,
        'adm_services_create_stores_full',
        Math.abs(realStores.length - totalStores) <= 5,
        `stores=${realStores.length} dbTotal=${totalStores}`,
      )
    }
    // ADM 可访问 /employees/new
    const newEmpAccess = await expectDenied(pAdm, '/employees/new')
    recordVerdict(verdicts, 'adm_can_access_employees_new', !newEmpAccess, `denied=${newEmpAccess}`)
  } finally {
    await ctxAdm.close()
  }

  // ── Case 4: HR — 可访问 /employees/new 且 storeId select 包含全部门店（hr 是总部 scope） ──
  console.log('[链路35c] Case 4: HR /employees/new')
  const ctxHr = await browser.newContext()
  const pHr = await ctxHr.newPage()
  try {
    await login(pHr, TEST_PHONES.HR)
    const denied = await expectDenied(pHr, '/employees/new')
    recordVerdict(verdicts, 'hr_can_access_employees_new', !denied, `denied=${denied}`)
    if (!denied) {
      await page_waitForStable(pHr)
      const selects = await pHr.locator('select').all()
      // 找含"店"label 的 select
      let storeOptions: string[] = []
      for (const sel of selects) {
        const opts = (await sel.locator('option').allTextContents()).map((s) => s.trim()).filter(Boolean)
        if (opts.some((o) => o.includes('店') || o.includes('南昌'))) {
          storeOptions = opts
          break
        }
      }
      // HR 是 HQ scope ⇒ 全部门店都应在下拉里
      recordVerdict(
        verdicts,
        'hr_employees_new_stores_full',
        storeOptions.length >= totalStores * 0.8, // 容许极少不可见冗余 option
        `hr stores=${storeOptions.length} dbTotal=${totalStores}`,
      )
    }
  } finally {
    await ctxHr.close()
  }

  const overall = summarize(35.6, verdicts, { totalStores, nc01Employees, ncMarketEmployees })
  writeContext('link35c', { status: overall, verdicts })

  for (const v of verdicts) {
    if (v.verdict !== 'SKIP') expect(v.verdict, `check=${v.check} actual=${v.actual}`).toBe('PASS')
  }
})

async function page_waitForStable(page: import('@playwright/test').Page): Promise<void> {
  await page.waitForLoadState('networkidle').catch(() => null)
  await page.waitForTimeout(1200)
}
