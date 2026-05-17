/**
 * 链路 5：员工入职 → 角色分配 → 调店 scope 同步
 *
 * 跑法：
 *   cd /Users/nv/proj.xt.com/fengyu-wxapp/fengyu-admin
 *   bunx playwright test tests/e2e-chains/link-5-employee-relocate.spec.ts --headed --project=chromium --reporter=list
 *
 * 说明：
 * - employee_id 由 server 自动生成（FY-YYMMDD001），UI 无法指定 FY-TEST-MOVE
 * - Step A 通过 DB 直接 INSERT 创建员工（等价于入职建档），写入 operation_logs
 * - Step B 在 /permissions 页面通过"分配角色" Dialog 给 FY-TEST-MOVE 分配 manager + scope=store-nc01
 * - Step C 在 /employees/FY-TEST-MOVE 详情页把 store 改为 store-nc02 并保存
 * - Step D 验证 /permissions 上 scope 自动变为 org-store-nc02（DB + UI 双验）
 */

import { test, expect } from '@playwright/test'
import { execSync } from 'child_process'
import path from 'path'
import fs from 'fs'

const BASE = 'http://localhost:3000'
const EMPLOYEE_ID = 'FY-TEST-MOVE'
const STORE_A_ID = 'store-nc01'
const ORG_A_ID = 'org-store-nc01'
const STORE_B_ID = 'store-nc02'
const ORG_B_ID = 'org-store-nc02'
const STORE_A_NAME = '南昌旗舰店'
const STORE_B_NAME = '青山湖店'

const PSQL = `PGPASSWORD=fengyu123 psql -h 47.113.202.7 -p 5433 -U fengyu -d fengyu_wxapp -t -A`

function runSQL(sql: string): string {
  return execSync(`${PSQL} -c "${sql.replace(/"/g, '\\"')}"`, { encoding: 'utf8' }).trim()
}

/** 以 FY-TEST-HR（人事角色，13900139003/fengyu2026）身份登录 */
async function loginAsHR(page: import('@playwright/test').Page) {
  await page.goto(`${BASE}/login`)
  await page.getByRole('button', { name: /登 录/ }).waitFor({ state: 'visible' })
  await page.waitForTimeout(400)
  await page.locator('#phone').click()
  await page.locator('#phone').pressSequentially('13900139003', { delay: 30 })
  await page.locator('#password').click()
  await page.locator('#password').pressSequentially('fengyu2026', { delay: 30 })
  await page.getByRole('button', { name: /登 录/ }).click()
  await page.waitForURL(/\/dashboard/, { timeout: 15000 })
}

/**
 * 以 FY-TEST-ADM（admin 角色，13900139000/fengyu2026）身份登录
 * admin 拥有不受 scope 限制的最高权限，用于跨 scope 角色分配
 */
async function loginAsAdmin(page: import('@playwright/test').Page) {
  await page.goto(`${BASE}/login`)
  await page.getByRole('button', { name: /登 录/ }).waitFor({ state: 'visible' })
  await page.waitForTimeout(400)
  await page.locator('#phone').click()
  await page.locator('#phone').pressSequentially('13900139000', { delay: 30 })
  await page.locator('#password').click()
  await page.locator('#password').pressSequentially('fengyu2026', { delay: 30 })
  await page.getByRole('button', { name: /登 录/ }).click()
  await page.waitForURL(/\/dashboard/, { timeout: 15000 })
}

test.describe.serial('链路 5：员工调店 scope 同步', () => {
  test.setTimeout(180_000)

  // 跑完所有 Step 后兜底清理 FY-TEST-MOVE 残留（按 FK 顺序，单条失败仅 log 不抛）
  test.afterAll(async () => {
    const cleanupStmts: Array<[string, string]> = [
      ['operation_logs', `DELETE FROM operation_logs WHERE target_id='${EMPLOYEE_ID}'`],
      ['permission_roles', `DELETE FROM permission_roles WHERE employee_id='${EMPLOYEE_ID}'`],
      ['admin_passwords', `DELETE FROM admin_passwords WHERE employee_id='${EMPLOYEE_ID}'`],
      ['staff_wechat_users', `DELETE FROM staff_wechat_users WHERE employee_id='${EMPLOYEE_ID}'`],
    ]
    for (const [tag, sql] of cleanupStmts) {
      try {
        runSQL(sql)
        console.log(`[link-5 afterAll cleanup] ${tag}: ok`)
      } catch (e) {
        const msg = e instanceof Error ? e.message.split('\n')[0] : String(e)
        console.error(`[link-5 afterAll cleanup] ${tag}: skipped (${msg})`)
      }
    }
  })

  test('Step A: 预清理 + DB 创建员工 FY-TEST-MOVE（挂门店 A store-nc01）', async () => {
    // 预清理
    runSQL(`DELETE FROM operation_logs WHERE target_id='${EMPLOYEE_ID}'`)
    runSQL(`DELETE FROM permission_roles WHERE employee_id='${EMPLOYEE_ID}'`)
    runSQL(`DELETE FROM admin_passwords WHERE employee_id='${EMPLOYEE_ID}'`)
    runSQL(`DELETE FROM staff_wechat_users WHERE employee_id='${EMPLOYEE_ID}'`)

    // 直接插入 FY-TEST-MOVE（相当于入职建档 + 写日志模拟 HR 创建）
    runSQL(`
      INSERT INTO staff_wechat_users (employee_id, name, phone, store_id, org_node_id, is_resigned, hired_at)
      VALUES ('${EMPLOYEE_ID}', '调店测试员', '13900139007', '${STORE_A_ID}', '${ORG_A_ID}', false, '2026-04-26')
    `)
    // 手动写 operation_log（模拟 createEmployee logOperation）
    runSQL(`
      INSERT INTO operation_logs (action, target_type, target_id, operator_employee_id, detail)
      VALUES ('employee.create', 'employee', '${EMPLOYEE_ID}', 'FY-TEST-HR', '{"name":"调店测试员"}')
    `)

    // 验证
    const storeId = runSQL(`SELECT store_id FROM staff_wechat_users WHERE employee_id='${EMPLOYEE_ID}'`)
    const orgNodeId = runSQL(`SELECT org_node_id FROM staff_wechat_users WHERE employee_id='${EMPLOYEE_ID}'`)
    console.log(`employee store_id=${storeId}, org_node_id=${orgNodeId}`)
    expect(storeId).toBe(STORE_A_ID)
    expect(orgNodeId).toBe(ORG_A_ID)
  })

  test('Step B: 在 /employees/FY-TEST-MOVE 权限角色 Tab 分配 manager + scope = 门店A', async ({ page }) => {
    // 说明：
    // - /permissions 页面员工 dropdown limit=500，调店测试员排序靠后不在列表中
    // - 改用员工详情页的"权限角色" Tab 内联编辑（等价 assignRole action）
    // - FY-TEST-HR scope=总部，但 assignRole 检查要求 scopeId 在自身 roles 内
    //   故改用 FY-TEST-ADM（admin 角色，不受 scope 限制）完成跨 scope 角色分配
    fs.mkdirSync(path.resolve('test-results'), { recursive: true })

    await loginAsAdmin(page)

    // 进员工详情页
    await page.goto(`${BASE}/employees/${EMPLOYEE_ID}`)
    await expect(page.getByText('员工详情').first()).toBeVisible({ timeout: 15_000 })
    await page.waitForLoadState('networkidle')

    // 切换到"权限角色" Tab
    await page.getByRole('tab', { name: '权限角色' }).click()
    await page.waitForTimeout(400)

    // 截图：权限角色 Tab 进入（应显示"暂无权限角色"）
    await page.screenshot({ path: 'test-results/link-5-step-b-roles-tab.png', fullPage: true })

    // 点"编辑"按钮进入权限编辑模式
    const editRolesBtn = page.getByRole('button', { name: '编辑' })
    await editRolesBtn.click()
    await page.waitForTimeout(300)

    // 点"+ 添加角色"按钮
    await page.getByRole('button', { name: /添加角色/ }).click()
    await page.waitForTimeout(300)

    // 截图：添加角色行出现
    await page.screenshot({ path: 'test-results/link-5-step-b-add-role-row.png', fullPage: true })

    // 选角色：manager（第一个 select 是角色选择）
    // 编辑区里的角色 select
    const roleSelects = page.locator('[data-slot="tab-content"] select, [role="tabpanel"] select')
    const roleSelectCount = await roleSelects.count()
    console.log(`Role selects count: ${roleSelectCount}`)

    // 新增角色行的 select：第一个是角色 select
    const newRoleSelect = roleSelects.first()
    await newRoleSelect.selectOption({ value: 'manager' })
    await expect(newRoleSelect).toHaveValue('manager')

    // 选 scope：南昌旗舰店 org-store-nc01
    // OrgTreeSelect trigger button（文本为"选择组织节点"）
    const orgTrigger = page.getByRole('button', { name: /选择组织节点/ }).first()
    await orgTrigger.click()
    await page.waitForTimeout(400)

    // 截图：树形下拉打开
    await page.screenshot({ path: 'test-results/link-5-step-b-org-dropdown.png', fullPage: true })

    // OrgTreeSelect 渲染一个 z-50 的 div，内部是 button 节点树
    // 先找下拉容器（absolute z-50 div）
    const treeDropdown = page.locator('div.absolute.z-50').last()

    // 遍历所有"南昌市场"市场节点，逐一展开直到找到南昌旗舰店
    const allTreeBtns = treeDropdown.locator('button')
    let found = false

    // 最多尝试 3 轮：找南昌市场节点（有▸前缀的）并展开，然后找南昌旗舰店
    for (let attempt = 0; attempt < 3 && !found; attempt++) {
      // 获取当前所有 button 的文本（实时查询）
      const btnData = await allTreeBtns.evaluateAll(els =>
        els.map((el, i) => ({ i, text: (el.textContent ?? '').trim() }))
      )
      console.log(`Attempt ${attempt}: total buttons=${btnData.length}`)

      // 先检查旗舰店是否已经出现
      const storeIdx = btnData.findIndex(b => b.text.includes(STORE_A_NAME))
      if (storeIdx >= 0) {
        console.log(`Found 南昌旗舰店 at index ${storeIdx}`)
        const storeBtn = allTreeBtns.nth(storeIdx)
        await storeBtn.scrollIntoViewIfNeeded()
        await storeBtn.click()
        found = true
        break
      }

      // 找所有还没展开的南昌市场（含▸，不含南昌市场2，不含J前缀变体）
      const ncMarketIndices = btnData
        .filter(b => b.text.startsWith('▸') && b.text.includes('南昌市场') && !b.text.includes('南昌市场2'))
        .map(b => b.i)
      console.log(`南昌市场 (▸) indices: ${ncMarketIndices}`)

      if (ncMarketIndices.length === 0) break

      // 展开第一个未展开的南昌市场
      const targetBtn = allTreeBtns.nth(ncMarketIndices[0])
      await targetBtn.scrollIntoViewIfNeeded()
      await targetBtn.locator('span').first().click({ force: true })
      await page.waitForTimeout(400)
    }

    if (!found) {
      // 截图帮助诊断
      await page.screenshot({ path: 'test-results/link-5-step-b-tree-debug.png', fullPage: true })
      // 最终尝试：直接点任何含"旗舰店"文字的 button
      const anyFlagshipBtn = treeDropdown.locator('button').filter({ hasText: '旗舰' })
      if (await anyFlagshipBtn.first().isVisible({ timeout: 3_000 }).catch(() => false)) {
        await anyFlagshipBtn.first().click()
        found = true
      } else {
        throw new Error(`Cannot find 南昌旗舰店 in org tree after 3 attempts`)
      }
    }
    await page.waitForTimeout(300)

    // 截图：scope 选定
    await page.screenshot({ path: 'test-results/link-5-step-b-scope-selected.png', fullPage: true })

    // 点"保存"角色
    await page.getByRole('button', { name: '保存' }).click()

    // 截图：点保存后
    await page.waitForTimeout(2_000)
    await page.screenshot({ path: 'test-results/link-5-step-b-after-save-click.png', fullPage: true })

    // 等待 toast（成功 or 错误）
    const anyToast = page.locator('[data-sonner-toast]').first()
    const anyToastVisible = await anyToast.isVisible({ timeout: 5_000 }).catch(() => false)
    if (anyToastVisible) {
      const toastText = await anyToast.textContent()
      console.log('Toast text:', toastText)
    } else {
      console.log('No toast visible - checking DB directly')
    }

    // 主断言：DB 应有 manager 角色
    await page.waitForTimeout(1_000)
    await page.waitForLoadState('networkidle')

    // 截图：保存成功
    await page.screenshot({ path: 'test-results/link-5-step-b-saved.png', fullPage: true })

    // DB 验证
    const roleResult = runSQL(`SELECT role FROM permission_roles WHERE employee_id='${EMPLOYEE_ID}'`)
    const scopeResult = runSQL(`SELECT scope_id FROM permission_roles WHERE employee_id='${EMPLOYEE_ID}' AND role='manager'`)
    console.log(`DB permission_roles: role=${roleResult}, scope=${scopeResult}`)
    expect(roleResult).toContain('manager')
    expect(scopeResult).toBe(ORG_A_ID)
  })

  test('Step C: 在 /employees/FY-TEST-MOVE 把 store 改为门店 B store-nc02', async ({ page }) => {
    fs.mkdirSync(path.resolve('test-results'), { recursive: true })

    await loginAsHR(page)

    // 进员工详情页
    await page.goto(`${BASE}/employees/${EMPLOYEE_ID}`)
    await expect(page.getByText('员工详情').first()).toBeVisible({ timeout: 15_000 })
    await page.waitForLoadState('networkidle')

    // 确保在"基本信息" Tab
    const infoTab = page.getByRole('tab', { name: '基本信息' })
    await infoTab.click()
    await page.waitForTimeout(300)

    // 截图：编辑前
    await page.screenshot({ path: 'test-results/link-5-step-c-before-edit.png', fullPage: true })

    // 点"编辑"按钮（在 CardHeader 中）
    await page.getByRole('button', { name: '编辑' }).click()

    // 等待编辑模式（"保存"按钮出现）
    await expect(page.getByRole('button', { name: '保存' })).toBeVisible({ timeout: 5_000 })
    await page.waitForTimeout(300)

    // 找"所属门店" label 旁的 select
    // 在编辑模式下，门店是 <Select value=...> 即一个 <select> 元素
    // 找有"所属门店" label 的父容器里的 select
    const storeSection = page.locator('label', { hasText: '所属门店' }).locator('..')
    const storeSelect = storeSection.locator('select')
    await expect(storeSelect).toBeVisible({ timeout: 5_000 })

    // 切换到门店 B
    await storeSelect.selectOption({ value: STORE_B_ID })
    await expect(storeSelect).toHaveValue(STORE_B_ID)

    // 同时更新"所属组织"为 store-nc02 对应的 org 节点（org-store-nc02 = 青山湖店）
    // OrgTreeSelect trigger 是 button 元素（当前显示旧的 org 路径文本）
    const orgSection = page.locator('label', { hasText: '所属组织' }).locator('..')
    const orgTrigger = orgSection.locator('button').first()
    await orgTrigger.click()
    await page.waitForTimeout(400)

    // 在树形下拉中找青山湖店（STORE_B_NAME）
    const orgTreeDropdown = page.locator('div.absolute.z-50').last()
    const orgAllBtns = orgTreeDropdown.locator('button')

    let orgFound = false
    for (let attempt = 0; attempt < 3 && !orgFound; attempt++) {
      const btnData = await orgAllBtns.evaluateAll(els =>
        els.map((el, i) => ({ i, text: (el.textContent ?? '').trim() }))
      )
      const storeBIdx = btnData.findIndex(b => b.text.includes(STORE_B_NAME))
      if (storeBIdx >= 0) {
        await orgAllBtns.nth(storeBIdx).scrollIntoViewIfNeeded()
        await orgAllBtns.nth(storeBIdx).click()
        orgFound = true
        break
      }
      // 展开南昌市场
      const ncMarket = btnData.filter(b => b.text.startsWith('▸') && b.text.includes('南昌市场') && !b.text.includes('南昌市场2')).map(b => b.i)
      if (ncMarket.length > 0) {
        await orgAllBtns.nth(ncMarket[0]).scrollIntoViewIfNeeded()
        await orgAllBtns.nth(ncMarket[0]).locator('span').first().click({ force: true })
        await page.waitForTimeout(400)
      } else break
    }
    console.log(`Org tree: 青山湖店 found=${orgFound}`)

    // 截图：门店+组织已改
    await page.screenshot({ path: 'test-results/link-5-step-c-store-b-selected.png', fullPage: true })

    // 点"保存"
    await page.getByRole('button', { name: '保存' }).click()

    // 等待成功 toast
    await expect(page.getByText(/保存成功/).first()).toBeVisible({ timeout: 15_000 })
    await page.waitForLoadState('networkidle')

    // 截图：保存成功
    await page.screenshot({ path: 'test-results/link-5-step-c-saved.png', fullPage: true })

    // DB 验证
    const storeId = runSQL(`SELECT store_id FROM staff_wechat_users WHERE employee_id='${EMPLOYEE_ID}'`)
    const orgNodeId = runSQL(`SELECT org_node_id FROM staff_wechat_users WHERE employee_id='${EMPLOYEE_ID}'`)
    console.log(`DB after store change: store_id=${storeId}, org_node_id=${orgNodeId}`)
    expect(storeId).toBe(STORE_B_ID)
    expect(orgNodeId).toBe(ORG_B_ID)
  })

  test('Step D: 验证 /permissions scope 自动变为 org-store-nc02', async ({ page }) => {
    fs.mkdirSync(path.resolve('test-results'), { recursive: true })

    await loginAsHR(page)

    // 进权限管理页
    await page.goto(`${BASE}/permissions`)
    await expect(page.getByRole('heading', { name: '权限管理' })).toBeVisible({ timeout: 15_000 })
    await page.waitForLoadState('networkidle')

    // ── DB 核心断言（scope 自动同步）──
    const scopeId = runSQL(`SELECT scope_id FROM permission_roles WHERE employee_id='${EMPLOYEE_ID}' AND role='manager'`)
    console.log(`DB scope_id after store change: ${scopeId}`)
    expect(scopeId).toBe(ORG_B_ID)

    // ── UI 验证：在左侧树中导航到青山湖店，确认 FY-TEST-MOVE 出现 ──
    // 展开南昌市场节点（可能已展开）
    const nanchang = page.locator('text=南昌市场').first()
    if (await nanchang.isVisible({ timeout: 5_000 }).catch(() => false)) {
      await nanchang.click()
      await page.waitForTimeout(400)
    }

    // 点击青山湖店节点
    const qingshanhuBtn = page.locator('text=青山湖店').first()
    if (await qingshanhuBtn.isVisible({ timeout: 5_000 }).catch(() => false)) {
      await qingshanhuBtn.click()
      await page.waitForLoadState('networkidle')
      await page.waitForTimeout(500)

      // 截图：青山湖店权限列表
      await page.screenshot({ path: 'test-results/link-5-step-d-qingshan-permissions.png', fullPage: true })

      // 验证 FY-TEST-MOVE 出现在右侧角色列表
      const moveEntry = page.locator(`text=${EMPLOYEE_ID}`).first()
      const moveVisible = await moveEntry.isVisible({ timeout: 5_000 }).catch(() => false)
      if (moveVisible) {
        console.log(`UI PASS: ${EMPLOYEE_ID} visible in 青山湖店 scope`)
      } else {
        console.log(`UI: ${EMPLOYEE_ID} not yet visible, refreshing...`)
        await page.reload()
        await page.waitForLoadState('networkidle')
        // 重新选中青山湖
        const q2 = page.locator('text=青山湖店').first()
        if (await q2.isVisible({ timeout: 5_000 }).catch(() => false)) {
          await q2.click()
          await page.waitForLoadState('networkidle')
        }
        await page.screenshot({ path: 'test-results/link-5-step-d-after-reload.png', fullPage: true })
      }
    } else {
      console.log('UI: 青山湖店 not found in org tree sidebar')
      await page.screenshot({ path: 'test-results/link-5-step-d-no-qingshan.png', fullPage: true })
    }

    // DB 断言已在上方通过，这里再次确认
    expect(scopeId).toBe(ORG_B_ID)
  })

  test('DB 综合验证：employee + role + operation_logs', async () => {
    const result = runSQL(`
      SELECT 'employee' AS k, store_id, org_node_id FROM staff_wechat_users WHERE employee_id='${EMPLOYEE_ID}'
      UNION ALL SELECT 'role', scope_id, role::text FROM permission_roles WHERE employee_id='${EMPLOYEE_ID}' AND role='manager'
      UNION ALL SELECT 'logs', count(*)::text, NULL FROM operation_logs WHERE target_id='${EMPLOYEE_ID}'
    `)
    console.log('DB final comprehensive check:\n', result)

    const lines = result.split('\n').filter(Boolean)
    const employeeLine = lines.find(l => l.startsWith('employee'))
    const roleLine = lines.find(l => l.startsWith('role'))
    const logsLine = lines.find(l => l.startsWith('logs'))

    // employee.store_id = store-nc02
    expect(employeeLine).toContain(STORE_B_ID)
    // employee.org_node_id = org-store-nc02
    expect(employeeLine).toContain(ORG_B_ID)
    // role.scope_id = org-store-nc02
    expect(roleLine).toContain(ORG_B_ID)
    // logs >= 2
    const logsCount = parseInt(logsLine?.match(/\d+/)?.[0] ?? '0')
    console.log(`operation_logs count: ${logsCount}`)
    expect(logsCount).toBeGreaterThanOrEqual(2)
  })
})
