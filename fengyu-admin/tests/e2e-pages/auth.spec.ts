import { test, expect } from '@playwright/test'
import { Client } from 'pg'
import { hashSync } from 'bcryptjs'

const PG_URL = process.env.E2E_DATABASE_URL || process.env.DATABASE_URL || 'postgresql://fengyu:fengyu123@101.34.242.103:5433/fengyu_wxapp'

// 改密成功用例专用一次性账号：避免改写共享测试账号 FY-TEST-ADM(13900139000) 的密码，
// 否则失败/中断会把共享账号密码改成 abc12345 → 后续所有登录用例连环挂。
const CPW = {
  employeeId: 'FY-TEST-CPW',
  name: '改密测试账号',
  phone: '13900139099',
  initialPassword: 'initpass123',
}

async function seedChangePasswordAccount() {
  const c = new Client({ connectionString: PG_URL })
  await c.connect()
  try {
    await c.query(
      `INSERT INTO staff_wechat_users (employee_id, name, phone)
       VALUES ($1, $2, $3)
       ON CONFLICT (employee_id) DO UPDATE SET name = EXCLUDED.name, phone = EXCLUDED.phone`,
      [CPW.employeeId, CPW.name, CPW.phone],
    )
    await c.query(
      `INSERT INTO admin_passwords (employee_id, password_hash, must_change)
       VALUES ($1, $2, true)
       ON CONFLICT (employee_id) DO UPDATE SET password_hash = EXCLUDED.password_hash, must_change = true, last_changed_at = NULL`,
      [CPW.employeeId, hashSync(CPW.initialPassword, 12)],
    )
    // 分配 admin 角色（总部 scope，与 FY-TEST-ADM 同范式）—— 无角色则 canAccessAdmin=false，
    // 登录报「账号权限不足」无法进改密页。
    await c.query(
      `INSERT INTO permission_roles (employee_id, role, scope_id)
       VALUES ($1, 'admin', '16d1184b46db099a')
       ON CONFLICT (employee_id, role, scope_id) DO NOTHING`,
      [CPW.employeeId],
    )
    // 清除可能残留的登录锁定记录
    await c.query(`DELETE FROM login_attempts WHERE phone = $1`, [CPW.phone])
  } finally {
    await c.end()
  }
}

async function cleanupChangePasswordAccount() {
  const c = new Client({ connectionString: PG_URL })
  await c.connect()
  try {
    await c.query(`DELETE FROM admin_passwords WHERE employee_id = $1`, [CPW.employeeId])
    await c.query(`DELETE FROM login_attempts WHERE phone = $1`, [CPW.phone])
    // 改密成功会写一条 auth.changePassword 审计日志（operator_employee_id FK 指向 staff），先清
    await c.query(`DELETE FROM operation_logs WHERE operator_employee_id = $1`, [CPW.employeeId])
    await c.query(`DELETE FROM permission_roles WHERE employee_id = $1`, [CPW.employeeId])
    await c.query(`DELETE FROM staff_wechat_users WHERE employee_id = $1`, [CPW.employeeId])
  } finally {
    await c.end()
  }
}

test.describe('登录页', () => {
  test.use({ storageState: { cookies: [], origins: [] } })

  // 「错误密码显示提示」用例每跑一次给 13800138000 累加一次 fail_count，反复本地重跑会触发
  // 账号锁定 → 提示变「账号已锁定」而非「手机号或密码错误」，用例自锁失败。每次跑前清掉该手机
  // 的失败/锁定记录，保证用例可重复执行（单次 CI 跑本就安全，此为本地连跑健壮性）。
  test.beforeEach(async () => {
    const c = new Client({ connectionString: PG_URL })
    await c.connect()
    try {
      await c.query(`DELETE FROM login_attempts WHERE phone = $1`, ['13800138000'])
    } finally {
      await c.end()
    }
  })

  test('渲染标题和表单', async ({ page }) => {
    await page.goto('/login')
    await expect(page.getByRole('heading', { name: '凤御美业管理后台' })).toBeVisible()
    await expect(page.getByLabel('手机号')).toBeVisible()
    await expect(page.getByLabel('密码')).toBeVisible()
    await expect(page.getByRole('button', { name: /登 录/ })).toBeVisible()
    await expect(page.getByText('首次登录？请联系管理员开通权限')).toBeVisible()
  })

  test('空提交显示验证错误', async ({ page }) => {
    await page.goto('/login')
    await page.getByRole('button', { name: /登 录/ }).click()
    await expect(page.getByText('请输入手机号')).toBeVisible()
  })

  test('只填手机号空密码提示错误', async ({ page }) => {
    await page.goto('/login')
    await page.getByLabel('手机号').fill('13800138000')
    await page.getByRole('button', { name: /登 录/ }).click()
    await expect(page.getByText('请输入密码')).toBeVisible()
  })

  test('非法手机号格式显示错误', async ({ page }) => {
    await page.goto('/login')
    await page.getByLabel('手机号').fill('123')
    await page.getByLabel('密码').fill('admin123')
    await page.getByRole('button', { name: /登 录/ }).click()
    await expect(page.getByText('请输入正确的手机号')).toBeVisible()
  })

  test('错误密码显示提示', async ({ page }) => {
    await page.goto('/login')
    await page.getByLabel('手机号').fill('13800138000')
    await page.getByLabel('密码').fill('wrongpassword')
    await page.getByRole('button', { name: /登 录/ }).click()
    // 表单 inline 错误 + sonner toast 都展示同一文案，取 first 避免 strict 冲突
    await expect(page.getByText('手机号或密码错误').first()).toBeVisible()
  })

  test('正确登录跳转到工作台', async ({ page }) => {
    await page.goto('/login')
    await page.getByLabel('手机号').fill('13900139000')
    await page.getByLabel('密码').fill('fengyu2026')
    await page.getByRole('button', { name: /登 录/ }).click()
    await expect(page).toHaveURL(/\/dashboard/, { timeout: 10000 })
  })

  test('手机号输入最大 11 位', async ({ page }) => {
    await page.goto('/login')
    const phoneInput = page.getByLabel('手机号')
    await expect(phoneInput).toHaveAttribute('maxlength', '11')
  })
})

test.describe('修改密码页', () => {
  test.use({ storageState: { cookies: [], origins: [] } })

  test('渲染标题和表单', async ({ page }) => {
    await page.goto('/change-password')
    await expect(page.getByRole('heading', { name: '修改密码' })).toBeVisible()
    await expect(page.getByText('首次登录需要修改初始密码')).toBeVisible()
    await expect(page.getByLabel('新密码')).toBeVisible()
    await expect(page.getByLabel('确认密码')).toBeVisible()
    await expect(page.getByRole('button', { name: '确认修改' })).toBeVisible()
  })

  test('空提交显示两项错误', async ({ page }) => {
    await page.goto('/change-password')
    await page.getByRole('button', { name: '确认修改' }).click()
    await expect(page.getByText('请输入新密码')).toBeVisible()
    await expect(page.getByText('请确认新密码')).toBeVisible()
  })

  test('弱密码（纯数字）拒绝', async ({ page }) => {
    await page.goto('/change-password')
    await page.getByLabel('新密码').fill('12345678')
    await page.getByLabel('确认密码').fill('12345678')
    await page.getByRole('button', { name: '确认修改' }).click()
    await expect(page.getByText('密码至少 8 位，需包含字母和数字')).toBeVisible()
  })

  test('两次密码不一致拒绝', async ({ page }) => {
    await page.goto('/change-password')
    await page.getByLabel('新密码').fill('abc12345')
    await page.getByLabel('确认密码').fill('abc12346')
    await page.getByRole('button', { name: '确认修改' }).click()
    await expect(page.getByText('两次输入的密码不一致')).toBeVisible()
  })

  // 改密成功必须有真实登录态（getSessionFromCookie 取得 session），否则
  // changePassword 直接返回 {success:false,'未登录'} 不跳转。用一次性账号 FY-TEST-CPW
  // 走真实登录 → mustChange 强制落改密页 → 提交，避免污染共享账号。
  test.describe('合法密码提交（一次性账号）', () => {
    test.beforeAll(async () => {
      await seedChangePasswordAccount()
    })
    test.afterAll(async () => {
      await cleanupChangePasswordAccount()
    })

    test('合法密码提交成功跳转', async ({ page }) => {
      // 1. 用初始密码登录 → mustChange=true 触发 middleware 跳转到改密页
      await page.goto('/login')
      await page.getByRole('button', { name: /登 录/ }).waitFor({ state: 'visible' })
      await page.locator('#phone').click()
      await page.locator('#phone').pressSequentially(CPW.phone, { delay: 30 })
      await page.locator('#password').click()
      await page.locator('#password').pressSequentially(CPW.initialPassword, { delay: 30 })
      await page.getByRole('button', { name: /登 录/ }).click()
      await page.waitForURL(/\/change-password/, { timeout: 15000 })

      // 2. 提交合法新密码 → 成功后跳转工作台
      await page.getByLabel('新密码').fill('abc12345')
      await page.getByLabel('确认密码').fill('abc12345')
      await page.getByRole('button', { name: '确认修改' }).click()
      await expect(page).toHaveURL(/\/dashboard/, { timeout: 10000 })
    })
  })
})
