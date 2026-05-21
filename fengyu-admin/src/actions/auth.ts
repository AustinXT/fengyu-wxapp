'use server'

import { cookies, headers } from 'next/headers'
import { SignJWT, jwtVerify } from 'jose'
import { compare, hash } from 'bcryptjs'
import { db } from '@/db'
import { adminPasswords } from '@db/admin-auth'
import { staffWechatUsers } from '@db/user'
import { permissionRoles } from '@db/permission'
import { orgNodes } from '@db/org'
import { eq } from 'drizzle-orm'
import { computeActions, expandScopeStoreIds } from '@/lib/permissions'
import { withPermission } from '@/lib/with-permission'
import { logOperation } from '@/lib/operation-log'
import type { AuthSession, RoleType } from '@/lib/types'

const JWT_SECRET = new TextEncoder().encode(
  process.env.JWT_SECRET || 'fengyu-admin-jwt-secret-dev-only'
)
const COOKIE_NAME = 'fy-admin-token'
const JWT_EXPIRES = '24h'
const COOKIE_MAX_AGE = 24 * 60 * 60 // 24h

/**
 * 会话 cookie 选项。
 *
 * `Secure` 标记必须与「客户端实际访问协议」一致：纯 HTTP 上设置 Secure cookie
 * 会被浏览器静默丢弃（既不存储也不回传），导致登录后第一个依赖 cookie 的
 * server action（如 changePassword）拿不到登录态 → 误报「未登录」。
 *
 * 因此 Secure 由请求的 `x-forwarded-proto` 自动判定（TLS 反代终止时会注入该头），
 * 不再依赖写死的 COOKIE_SECURE：HTTP 部署 → 不加 Secure，将来接入 HTTPS 反代 →
 * 自动加上，无需改代码。仅当显式 `COOKIE_SECURE=false` 时强制关闭（本地兜底）。
 */
async function sessionCookieOptions() {
  const proto = (await headers()).get('x-forwarded-proto')?.split(',')[0]?.trim()
  const secure = process.env.COOKIE_SECURE === 'false' ? false : proto === 'https'
  return {
    httpOnly: true,
    secure,
    sameSite: 'lax' as const,
    path: '/',
    maxAge: COOKIE_MAX_AGE,
  }
}

// ── 登录锁定（内存 Map） ──
const loginAttempts = new Map<string, { count: number; lockedUntil: number }>()
const MAX_ATTEMPTS = 5
const LOCK_DURATION = 15 * 60 * 1000 // 15 分钟

function checkLock(phone: string): string | null {
  const record = loginAttempts.get(phone)
  if (!record) return null
  if (record.lockedUntil > Date.now()) {
    const minutes = Math.ceil((record.lockedUntil - Date.now()) / 60000)
    return `账号已锁定，请 ${minutes} 分钟后重试`
  }
  if (record.lockedUntil <= Date.now() && record.count >= MAX_ATTEMPTS) {
    loginAttempts.delete(phone)
  }
  return null
}

function recordFailure(phone: string) {
  const record = loginAttempts.get(phone) || { count: 0, lockedUntil: 0 }
  record.count += 1
  if (record.count >= MAX_ATTEMPTS) {
    record.lockedUntil = Date.now() + LOCK_DURATION
  }
  loginAttempts.set(phone, record)
}

function clearFailure(phone: string) {
  loginAttempts.delete(phone)
}

// ── Server Actions ──

export async function login(
  phone: string,
  password: string
): Promise<{ success: boolean; message: string; mustChange?: boolean }> {
  // 检查锁定
  const lockMsg = checkLock(phone)
  if (lockMsg) return { success: false, message: lockMsg }

  // 通过 phone 查找员工
  const [staff] = await db
    .select({ employeeId: staffWechatUsers.employeeId, name: staffWechatUsers.name, phone: staffWechatUsers.phone })
    .from(staffWechatUsers)
    .where(eq(staffWechatUsers.phone, phone))
    .limit(1)

  if (!staff) {
    recordFailure(phone)
    return { success: false, message: '手机号或密码错误' }
  }

  // 查找密码记录
  const [pwRow] = await db
    .select()
    .from(adminPasswords)
    .where(eq(adminPasswords.employeeId, staff.employeeId))
    .limit(1)

  if (!pwRow) {
    recordFailure(phone)
    return { success: false, message: '手机号或密码错误' }
  }

  // 验证密码
  const valid = await compare(password, pwRow.passwordHash)
  if (!valid) {
    recordFailure(phone)
    return { success: false, message: '手机号或密码错误' }
  }

  clearFailure(phone)

  // 签发 JWT（含 mustChange 标记，供 middleware 零 DB 查询判断）
  const token = await new SignJWT({ employeeId: staff.employeeId, mustChange: pwRow.mustChange })
    .setProtectedHeader({ alg: 'HS256' })
    .setExpirationTime(JWT_EXPIRES)
    .setIssuedAt()
    .sign(JWT_SECRET)

  // 设置 httpOnly cookie
  const cookieStore = await cookies()
  cookieStore.set(COOKIE_NAME, token, await sessionCookieOptions())

  return { success: true, message: '登录成功', mustChange: pwRow.mustChange }
}

export async function logout(): Promise<void> {
  const cookieStore = await cookies()
  cookieStore.delete(COOKIE_NAME)
}

export async function changePassword(
  newPassword: string
): Promise<{ success: boolean; message: string }> {
  const session = await getSessionFromCookie()
  if (!session) {
    return { success: false, message: '未登录' }
  }

  const passwordHash = await hash(newPassword, 12)

  await db
    .update(adminPasswords)
    .set({
      passwordHash,
      mustChange: false,
      lastChangedAt: new Date(),
    })
    .where(eq(adminPasswords.employeeId, session.employeeId))

  await logOperation(session, 'auth.changePassword', 'admin_password', session.employeeId)

  // 重新签发 JWT（mustChange: false，使强制修改密码流程立即解除）
  const token = await new SignJWT({ employeeId: session.employeeId, mustChange: false })
    .setProtectedHeader({ alg: 'HS256' })
    .setExpirationTime(JWT_EXPIRES)
    .setIssuedAt()
    .sign(JWT_SECRET)

  const cookieStore = await cookies()
  cookieStore.set(COOKIE_NAME, token, await sessionCookieOptions())

  return { success: true, message: '密码修改成功' }
}

/**
 * 从 cookie 中读取 JWT → 验证 → 查询 DB → 构建 AuthSession
 */
export async function getSessionFromCookie(): Promise<AuthSession | null> {
  try {
    const cookieStore = await cookies()
    const token = cookieStore.get(COOKIE_NAME)?.value
    if (!token) return null

    const { payload } = await jwtVerify(token, JWT_SECRET)
    const employeeId = payload.employeeId as string
    if (!employeeId) return null

    // 查询员工信息
    const [staff] = await db
      .select({
        employeeId: staffWechatUsers.employeeId,
        name: staffWechatUsers.name,
        phone: staffWechatUsers.phone,
      })
      .from(staffWechatUsers)
      .where(eq(staffWechatUsers.employeeId, employeeId))
      .limit(1)

    if (!staff) return null

    // 查询角色（仅有效的）
    const roleRows = await db
      .select({
        role: permissionRoles.role,
        scopeId: permissionRoles.scopeId,
        scopeType: orgNodes.type,
      })
      .from(permissionRoles)
      .leftJoin(orgNodes, eq(permissionRoles.scopeId, orgNodes.id))
      .where(eq(permissionRoles.employeeId, employeeId))

    const roles = roleRows.map(r => ({
      role: r.role as RoleType,
      scopeId: r.scopeId,
      scopeType: (r.scopeType ?? '门店') as '总部' | '市场' | '门店',
    }))

    // 计算权限（computeActions 自 2026-05-18 起异步：从 DB 取权限矩阵 + 30s 缓存）
    const actions = await computeActions(roles)
    const scopeStoreIds = await expandScopeStoreIds(roles)

    return {
      employeeId: staff.employeeId,
      name: staff.name ?? '未命名',
      phone: staff.phone ?? '',
      roles,
      permissions: { actions, scopeStoreIds },
    }
  } catch {
    return null
  }
}

/**
 * 管理员为其他员工重置密码（创建或覆盖 admin_passwords）
 *
 * 2026-05-17 PR-Z2 后续：原手写 `isAdmin` 旁路改走 admin:reset_password 权限 + withPermission HOF。
 * session 入口统一从 getSession() 拿（lib/auth.ts 是 getSessionFromCookie 的 wrapper，行为等价）。
 */
export const resetEmployeePassword = withPermission(
  'admin:reset_password',
  async (
    session,
    employeeId: string,
    newPassword: string,
  ): Promise<{ success: boolean; message: string }> => {
  const passwordHash = await hash(newPassword, 12)

  // UPSERT: 若无记录则创建，有则更新
  const existing = await db
    .select({ id: adminPasswords.id })
    .from(adminPasswords)
    .where(eq(adminPasswords.employeeId, employeeId))
    .limit(1)

  if (existing.length > 0) {
    await db
      .update(adminPasswords)
      .set({ passwordHash, mustChange: true, lastChangedAt: new Date() })
      .where(eq(adminPasswords.employeeId, employeeId))
  } else {
    await db.insert(adminPasswords).values({
      employeeId,
      passwordHash,
      mustChange: true,
    })
  }

  await logOperation(session, 'auth.resetPassword', 'admin_password', employeeId, {
    targetEmployeeId: employeeId,
    isNewAccount: existing.length === 0,
  })

  return { success: true, message: '密码重置成功，用户首次登录需修改密码' }
  },
)

/**
 * 管理员将员工密码重置为初始密码（手机号后 6 位）
 *
 * 同 resetEmployeePassword：admin:reset_password 权限 + withPermission HOF。
 */
export const resetToDefaultPassword = withPermission(
  'admin:reset_password',
  async (
    session,
    employeeId: string,
  ): Promise<{ success: boolean; message: string }> => {
  // 查询员工手机号
  const [staff] = await db
    .select({ phone: staffWechatUsers.phone })
    .from(staffWechatUsers)
    .where(eq(staffWechatUsers.employeeId, employeeId))
    .limit(1)

  if (!staff?.phone || staff.phone.length < 6) {
    return { success: false, message: '该员工未绑定手机号，无法设置初始密码' }
  }

  const defaultPassword = staff.phone.slice(-6)
  const passwordHash = await hash(defaultPassword, 12)

  // UPSERT
  const existing = await db
    .select({ id: adminPasswords.id })
    .from(adminPasswords)
    .where(eq(adminPasswords.employeeId, employeeId))
    .limit(1)

  if (existing.length > 0) {
    await db
      .update(adminPasswords)
      .set({ passwordHash, mustChange: true, lastChangedAt: new Date() })
      .where(eq(adminPasswords.employeeId, employeeId))
  } else {
    await db.insert(adminPasswords).values({
      employeeId,
      passwordHash,
      mustChange: true,
    })
  }

  await logOperation(session, 'auth.resetToDefault', 'admin_password', employeeId, {
    targetEmployeeId: employeeId,
    isNewAccount: existing.length === 0,
  })

  return { success: true, message: '已重置为初始密码（手机号后 6 位），首次登录需修改密码' }
  },
)

/**
 * 检查 mustChange 标记（middleware 用）
 */
export async function checkMustChange(): Promise<boolean> {
  try {
    const cookieStore = await cookies()
    const token = cookieStore.get(COOKIE_NAME)?.value
    if (!token) return false

    const { payload } = await jwtVerify(token, JWT_SECRET)
    const employeeId = payload.employeeId as string
    if (!employeeId) return false

    const [pwRow] = await db
      .select({ mustChange: adminPasswords.mustChange })
      .from(adminPasswords)
      .where(eq(adminPasswords.employeeId, employeeId))
      .limit(1)

    return pwRow?.mustChange ?? false
  } catch {
    return false
  }
}
