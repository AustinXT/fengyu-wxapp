'use server'

import { cookies } from 'next/headers'
import { SignJWT, jwtVerify } from 'jose'
import { compare, hash } from 'bcryptjs'
import { db } from '@/db'
import { adminPasswords } from '@db/admin-auth'
import { staffWechatUsers } from '@db/user'
import { permissionRoles } from '@db/permission'
import { orgNodes } from '@db/org'
import { eq } from 'drizzle-orm'
import { computeActions, expandScopeStoreIds } from '@/lib/permissions'
import { logOperation } from '@/lib/operation-log'
import type { AuthSession, RoleType } from '@/lib/types'

const JWT_SECRET = new TextEncoder().encode(
  process.env.JWT_SECRET || 'fengyu-admin-jwt-secret-dev-only'
)
const COOKIE_NAME = 'fy-admin-token'
const JWT_EXPIRES = '24h'

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
  cookieStore.set(COOKIE_NAME, token, {
    httpOnly: true,
    secure: process.env.COOKIE_SECURE !== 'false' && process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    path: '/',
    maxAge: 24 * 60 * 60, // 24h
  })

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
  cookieStore.set(COOKIE_NAME, token, {
    httpOnly: true,
    secure: process.env.COOKIE_SECURE !== 'false' && process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    path: '/',
    maxAge: 24 * 60 * 60,
  })

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
      scopeType: (r.scopeType ?? 'store') as 'headquarters' | 'market' | 'store',
    }))

    // 计算权限
    const actions = computeActions(roles)
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
 */
export async function resetEmployeePassword(
  employeeId: string,
  newPassword: string
): Promise<{ success: boolean; message: string }> {
  const session = await getSessionFromCookie()
  if (!session) {
    return { success: false, message: '未登录' }
  }

  // 仅 admin 可重置他人密码
  const isAdmin = session.roles.some(r => r.role === 'admin')
  if (!isAdmin) {
    return { success: false, message: '仅系统管理员可重置密码' }
  }

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
}

/**
 * 管理员将员工密码重置为初始密码（手机号后 6 位）
 */
export async function resetToDefaultPassword(
  employeeId: string
): Promise<{ success: boolean; message: string }> {
  const session = await getSessionFromCookie()
  if (!session) {
    return { success: false, message: '未登录' }
  }

  const isAdmin = session.roles.some(r => r.role === 'admin')
  if (!isAdmin) {
    return { success: false, message: '仅系统管理员可重置密码' }
  }

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
}

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
