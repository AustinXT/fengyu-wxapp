'use server'

import { cookies, headers } from 'next/headers'
import { SignJWT, jwtVerify } from 'jose'
import { compare, hash } from 'bcryptjs'
import { db } from '@/db'
import { adminPasswords } from '@db/admin-auth'
import { loginAttempts } from '@db/login-attempt'
import { staffWechatUsers } from '@db/user'
import { permissionRoles } from '@db/permission'
import { orgNodes } from '@db/org'
import { eq, sql } from 'drizzle-orm'
import { computeActions, expandScopeStoreIds, canAccessAdmin } from '@/lib/permissions'
import { decryptPassword } from '@/lib/password-transit'
import { JWT_SECRET } from '@/lib/jwt-secret'
import { withPermission } from '@/lib/with-permission'
import { logOperation } from '@/lib/operation-log'
import type { AuthSession, RoleType } from '@/lib/types'
import { nowTs } from '@/lib/db-time'

const COOKIE_NAME = 'fy-admin-token'
const JWT_EXPIRES = '24h'
const COOKIE_MAX_AGE = 24 * 60 * 60 


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


const MAX_ATTEMPTS = 5
const LOCK_DURATION_MS = 15 * 60 * 1000 


async function checkLock(phone: string): Promise<string | null> {
  const [row] = await db
    .select({ lockedUntil: loginAttempts.lockedUntil })
    .from(loginAttempts)
    .where(eq(loginAttempts.phone, phone))
    .limit(1)

  if (!row?.lockedUntil) return null

  const remainingMs = row.lockedUntil.getTime() - Date.now()
  if (remainingMs > 0) {
    const minutes = Math.ceil(remainingMs / 60000)
    return `账号已锁定，请 ${minutes} 分钟后重试`
  }
  return null
}


async function recordFailure(phone: string): Promise<void> {
  const lockExpr = sql`CASE WHEN ${loginAttempts.failCount} + 1 >= ${MAX_ATTEMPTS}
    THEN now() + (${LOCK_DURATION_MS} || ' milliseconds')::interval
    ELSE NULL END`

  await db
    .insert(loginAttempts)
    .values({ phone, failCount: 1, lastFailedAt: nowTs() })
    .onConflictDoUpdate({
      target: loginAttempts.phone,
      set: {
        failCount: sql`${loginAttempts.failCount} + 1`,
        lockedUntil: lockExpr,
        lastFailedAt: nowTs(),
        updatedAt: nowTs(),
      },
    })
}


async function clearFailure(phone: string): Promise<void> {
  await db.delete(loginAttempts).where(eq(loginAttempts.phone, phone))
}



export async function login(
  phone: string,
  encryptedPassword: string
): Promise<{ success: boolean; message: string; mustChange?: boolean }> {
  
  const lockMsg = await checkLock(phone)
  if (lockMsg) return { success: false, message: lockMsg }

  
  let password: string
  try {
    password = decryptPassword(encryptedPassword)
  } catch (e) {
    
    
    if (!process.env.RSA_PRIVATE_KEY) throw e
    await recordFailure(phone)
    return { success: false, message: '手机号或密码错误' }
  }

  
  const [staff] = await db
    .select({ employeeId: staffWechatUsers.employeeId, name: staffWechatUsers.name, phone: staffWechatUsers.phone })
    .from(staffWechatUsers)
    .where(eq(staffWechatUsers.phone, phone))
    .limit(1)

  if (!staff) {
    await recordFailure(phone)
    return { success: false, message: '手机号或密码错误' }
  }

  
  const [pwRow] = await db
    .select()
    .from(adminPasswords)
    .where(eq(adminPasswords.employeeId, staff.employeeId))
    .limit(1)

  if (!pwRow) {
    await recordFailure(phone)
    return { success: false, message: '手机号或密码错误' }
  }

  
  const valid = await compare(password, pwRow.passwordHash)
  if (!valid) {
    await recordFailure(phone)
    return { success: false, message: '手机号或密码错误' }
  }

  await clearFailure(phone)

  
  
  const adminRoleRows = await db
    .select({ role: permissionRoles.role })
    .from(permissionRoles)
    .where(eq(permissionRoles.employeeId, staff.employeeId))
  if (!canAccessAdmin(adminRoleRows)) {
    return { success: false, message: '账号权限不足，无法登录管理后台' }
  }

  
  const token = await new SignJWT({ employeeId: staff.employeeId, mustChange: pwRow.mustChange })
    .setProtectedHeader({ alg: 'HS256' })
    .setExpirationTime(JWT_EXPIRES)
    .setIssuedAt()
    .sign(JWT_SECRET)

  
  const cookieStore = await cookies()
  cookieStore.set(COOKIE_NAME, token, await sessionCookieOptions())

  return { success: true, message: '登录成功', mustChange: pwRow.mustChange }
}

export async function logout(): Promise<void> {
  const cookieStore = await cookies()
  cookieStore.delete(COOKIE_NAME)
}

export async function changePassword(
  encryptedNewPassword: string
): Promise<{ success: boolean; message: string }> {
  const session = await getSessionFromCookie()
  if (!session) {
    return { success: false, message: '未登录' }
  }

  
  let newPassword: string
  try {
    newPassword = decryptPassword(encryptedNewPassword)
  } catch (e) {
    if (!process.env.RSA_PRIVATE_KEY) throw e
    return { success: false, message: '密码修改失败，请重试' }
  }

  const passwordHash = await hash(newPassword, 12)

  await db
    .update(adminPasswords)
    .set({
      passwordHash,
      mustChange: false,
      lastChangedAt: nowTs(),
    })
    .where(eq(adminPasswords.employeeId, session.employeeId))

  await logOperation(session, 'auth.changePassword', 'admin_password', session.employeeId)

  
  const token = await new SignJWT({ employeeId: session.employeeId, mustChange: false })
    .setProtectedHeader({ alg: 'HS256' })
    .setExpirationTime(JWT_EXPIRES)
    .setIssuedAt()
    .sign(JWT_SECRET)

  const cookieStore = await cookies()
  cookieStore.set(COOKIE_NAME, token, await sessionCookieOptions())

  return { success: true, message: '密码修改成功' }
}


export async function getSessionFromCookie(): Promise<AuthSession | null> {
  try {
    const cookieStore = await cookies()
    const token = cookieStore.get(COOKIE_NAME)?.value
    if (!token) return null

    const { payload } = await jwtVerify(token, JWT_SECRET)
    const employeeId = payload.employeeId as string
    if (!employeeId) return null

    
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

    
    
    if (!canAccessAdmin(roles)) return null

    
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


export const resetEmployeePassword = withPermission(
  'admin:reset_password',
  async (
    session,
    employeeId: string,
    newPassword: string,
  ): Promise<{ success: boolean; message: string }> => {
  const passwordHash = await hash(newPassword, 12)

  
  const existing = await db
    .select({ id: adminPasswords.id })
    .from(adminPasswords)
    .where(eq(adminPasswords.employeeId, employeeId))
    .limit(1)

  if (existing.length > 0) {
    await db
      .update(adminPasswords)
      .set({ passwordHash, mustChange: true, lastChangedAt: nowTs() })
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


export const resetToDefaultPassword = withPermission(
  'admin:reset_password',
  async (
    session,
    employeeId: string,
  ): Promise<{ success: boolean; message: string }> => {
  
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

  
  const existing = await db
    .select({ id: adminPasswords.id })
    .from(adminPasswords)
    .where(eq(adminPasswords.employeeId, employeeId))
    .limit(1)

  if (existing.length > 0) {
    await db
      .update(adminPasswords)
      .set({ passwordHash, mustChange: true, lastChangedAt: nowTs() })
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
