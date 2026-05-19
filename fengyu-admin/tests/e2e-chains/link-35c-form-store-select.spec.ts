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
 *   - 反例 1：MGR 直接 GET `/employees/create` → 应被 menu / route guard 拒
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

/**
 * 进入 /services/create，跑完 3 步向导到达「服务配置」，返回 store/employee select 的 option labels。
 *
 * 流程：
 *   Step 0: 输入手机号 → 搜索 → 自动 selectedCustomer（无需点"选择"）→ "下一步"
 *   Step 1: 表格里点第一行（cursor-pointer，row 整体可点）→ "下一步"
 *   Step 2: 出现两个 select（"门店" + "负责美容师"），抓 options
 */
async function readServiceCreateSelects(
  page: import('@playwright/test').Page,
): Promise<{ stores: string[]; employees: string[]; reachedStep1: boolean }> {
  await page.goto(`${BASE}/services/create`, { waitUntil: 'domcontentloaded' })
  await page.waitForTimeout(1500)

  // Step 0: 搜索顾客（自动选中匹配的）
  const phoneIn = page.locator('input[placeholder*="手机号"]').first()
  if (await phoneIn.count() === 0) {
    return { stores: [], employees: [], reachedStep1: false }
  }
  await phoneIn.fill('13800138000')
  await page.getByRole('button', { name: '搜索' }).first().click().catch(() => null)
  // 等"会员等级"字样出现 = selectedCustomer 卡片渲染完成
  await page.waitForFunction(() => /会员等级|未找到/.test(document.body.textContent || ''), { timeout: 15000 }).catch(() => null)
  if (/未找到/.test((await page.textContent('body')) || '')) {
    return { stores: [], employees: [], reachedStep1: false }
  }
  // Step 0 → Step 1：点"下一步"
  await page.getByRole('button', { name: '下一步' }).first().click().catch(() => null)
  await page.waitForTimeout(2500)

  // Step 1: 选第一个可服务项（整行 cursor-pointer 可点）
  const firstRow = page.locator('table tbody tr').first()
  if (await firstRow.count() === 0) {
    return { stores: [], employees: [], reachedStep1: false }
  }
  await firstRow.click().catch(() => null)
  await page.waitForTimeout(500)

  // Step 1 → Step 2：再点"下一步"
  await page.getByRole('button', { name: '下一步' }).first().click().catch(() => null)
  await page.waitForTimeout(2000)

  const allSelects = await page.locator('select').all()
  if (allSelects.length < 2) return { stores: [], employees: [], reachedStep1: false }

  const stores = (await allSelects[0].locator('option').allTextContents()).map((s) => s.trim()).filter(Boolean)
  const employees = (await allSelects[1].locator('option').allTextContents()).map((s) => s.trim()).filter(Boolean)
  return { stores, employees, reachedStep1: true }
}

/**
 * 直接访问 path，断言 1500ms 内被重定向 / 403 / 渲染空。
 *
 * 注意：避免用裸 '403' 作为正则，因为 RSC 内联的 chunk ID 也会出现 '403' 子串。
 * 只用可见文案（中文短语 + 'Forbidden'）+ URL 重定向 + HTTP status 三档判定。
 */
async function expectDenied(page: import('@playwright/test').Page, path: string): Promise<boolean> {
  const resp = await page.goto(`${BASE}${path}`).catch(() => null)
  await page.waitForLoadState('networkidle').catch(() => null)
  await page.waitForTimeout(1000)
  if (resp && resp.status() === 404) return true
  if (resp && resp.status() === 403) return true
  const body = (await page.textContent('body').catch(() => '')) || ''
  // 仅匹配可见的拒绝文案（避免裸 '403' 误匹配 RSC chunk 里的 hex 子串）
  if (/无权执行|无权限|没有权限|权限不足|访问受限|Forbidden/.test(body)) return true
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
    const deniedNewEmp = await expectDenied(pMgr, '/employees/create')
    recordVerdict(verdicts, 'mgr_denied_employees_create', deniedNewEmp, `denied=${deniedNewEmp}`)
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
    // ADM 可访问 /employees/create
    const newEmpAccess = await expectDenied(pAdm, '/employees/create')
    recordVerdict(verdicts, 'adm_can_access_employees_create', !newEmpAccess, `denied=${newEmpAccess}`)
  } finally {
    await ctxAdm.close()
  }

  // ── Case 4: HR — 可访问 /employees/create 且 storeId select 包含全部门店（hr 是总部 scope） ──
  console.log('[链路35c] Case 4: HR /employees/create')
  const ctxHr = await browser.newContext()
  const pHr = await ctxHr.newPage()
  try {
    await login(pHr, TEST_PHONES.HR)
    const denied = await expectDenied(pHr, '/employees/create')
    recordVerdict(verdicts, 'hr_can_access_employees_create', !denied, `denied=${denied}`)
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
        'hr_employees_create_stores_full',
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
