'use server'

import { cookies, headers } from 'next/headers'
import { SignJWT, jwtVerify } from 'jose'
import { compare, hash } from 'bcryptjs'
import { db } from '@/db'
import { adminPasswords } from '@db/admin-auth'
import { loginAttempts } from '@db/login-attempt'
import { staffWechatUsers } from '@db/user'
import { permissionRoleDefinitions, permissionRoles } from '@db/permission'
import { orgNodes } from '@db/org'
import { eq, and, sql } from 'drizzle-orm'
import { computeRoleActions, expandRoleScope, canAccessAdmin } from '@/lib/permissions'
import { decryptPassword } from '@/lib/password-transit'
import { JWT_SECRET } from '@/lib/jwt-secret'
import { withPermission } from '@/lib/with-permission'
import { logOperation } from '@/lib/operation-log'
import type { AuthSession, RoleType } from '@/lib/types'
import { nowTs } from '@/lib/db-time'

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
  const domain = process.env.COOKIE_DOMAIN?.trim()
  return {
    httpOnly: true,
    secure,
    sameSite: 'lax' as const,
    path: '/',
    maxAge: COOKIE_MAX_AGE,
    ...(domain ? { domain } : {}),
  }
}

// ── 登录锁定（PG 持久化，防爆破；多实例 / 重启不丢失） ──
const MAX_ATTEMPTS = 5
const LOCK_DURATION_MS = 15 * 60 * 1000 // 15 分钟

/**
 * 检查手机号是否处于锁定状态。
 * 锁定中 → 返回提示文案；未锁定或锁定已过期 → 返回 null。
 */
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

/**
 * 一个真实形状的 bcrypt hash（cost 12），内容是随机口令，**永远不会有人匹配上它**。
 * 只用来在「查不到人 / 没有密码记录」这两条早退路径上烧掉一次等量的 bcrypt 计算。
 */
const DUMMY_PASSWORD_HASH = '$2a$12$C6UzMDM.H6dfI/f/IKcEe.KTSjS0Nn7Dm0MhJ7tVqCJIxMdkb5J5u'

/**
 * 拉平登录失败路径的耗时（issue #318，GLM 第 2 轮 P3）。
 *
 * 文案统一成同一句只挡住了**内容**信道，还剩一条**时序**信道：查不到人时直接返回，
 * 不跑 bcrypt；「人存在但密码错」要跑一次 cost-12 的 compare（几十到上百毫秒）。
 * 两者耗时差一个数量级，于是登录接口成了按手机号枚举「在职且有后台凭证」账号的 oracle。
 *
 * 本次给 `login` 加 `is_resigned = false` 过滤**放大**了这条信道 —— 离职的人从「慢路径」
 * 掉到了「快路径」，等于把「此人已离职」重新变成可探测信息，正是 AC5 要挡的。
 * 所以早退前烧掉一次等量 compare。
 *
 * ⚠️ 不追求严格恒定时间（JS 里做不到），只把数量级拉平到同一档。
 */
async function burnPasswordCompare(password: string): Promise<void> {
  try {
    await compare(password, DUMMY_PASSWORD_HASH)
  } catch {
    // 只为烧时间，任何异常都不该影响登录失败的返回值
  }
}

/**
 * 记录一次登录失败：原子 UPSERT 自增 fail_count；
 * 达到阈值则写入 locked_until。并发安全（依赖 phone 唯一索引 + ON CONFLICT 原子自增）。
 */
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

/** 登录成功后清除失败记录。 */
async function clearFailure(phone: string): Promise<void> {
  await db.delete(loginAttempts).where(eq(loginAttempts.phone, phone))
}

// ── Server Actions ──

export async function login(
  phone: string,
  encryptedPassword: string
): Promise<{ success: boolean; message: string; mustChange?: boolean }> {
  // 检查锁定
  const lockMsg = await checkLock(phone)
  if (lockMsg) return { success: false, message: lockMsg }

  // 解密传输层密文（前端用 RSA 公钥加密，见 lib/password-encrypt.ts）
  let password: string
  try {
    password = decryptPassword(encryptedPassword)
  } catch (e) {
    // 配置缺失（无 RSA_PRIVATE_KEY）→ fail-fast 暴露给运维；
    // 仅密文损坏/篡改 → 当作普通认证失败，不泄露区分
    if (!process.env.RSA_PRIVATE_KEY) throw e
    await recordFailure(phone)
    return { success: false, message: '手机号或密码错误' }
  }

  /**
   * 通过 phone 查找员工 —— **必须排除离职**（issue #318）。
   *
   * 原先不判 `is_resigned`：只要 `admin_passwords` 还有记录，离职员工就能继续登录后台。
   * 配上「离职 ⇒ 角色已清空」这个**会破的**不变量（`sync-workfine.js:381` 的 UPSERT
   * 直接改 `is_resigned` 而完全不碰 `permission_roles`），一旦出现「离职行 + 残留角色」，
   * 该账号就带着原有权限继续可用。
   *
   * 生产实测（2026-09-23）：2 人已离职却仍持后台登录凭证（王雯馨 2026-08-23 离职、
   * 关文星 2026-08-08 离职），两人当前角色数均为 0、离职后无任何操作日志 ——
   * 加这道过滤是纯收紧，零误伤。
   *
   * ⚠️ 查不到时走的是与密码错误**完全相同**的那一句 —— 不能让「此人已离职」变成
   * 一个可探测的信号（登录接口本来就是无鉴权入口）。
   */
  const [staff] = await db
    .select({ employeeId: staffWechatUsers.employeeId, name: staffWechatUsers.name, phone: staffWechatUsers.phone })
    .from(staffWechatUsers)
    .where(and(eq(staffWechatUsers.phone, phone), eq(staffWechatUsers.isResigned, false)))
    .limit(1)

  if (!staff) {
    await burnPasswordCompare(password)
    await recordFailure(phone)
    return { success: false, message: '手机号或密码错误' }
  }

  // 查找密码记录
  const [pwRow] = await db
    .select()
    .from(adminPasswords)
    .where(eq(adminPasswords.employeeId, staff.employeeId))
    .limit(1)

  if (!pwRow) {
    await burnPasswordCompare(password)
    await recordFailure(phone)
    return { success: false, message: '手机号或密码错误' }
  }

  // 验证密码
  const valid = await compare(password, pwRow.passwordHash)
  if (!valid) {
    await recordFailure(phone)
    return { success: false, message: '手机号或密码错误' }
  }

  await clearFailure(phone)

  // 禁止普通员工登录：staff（无任何管理角色）专供小程序端，不得进入 admin 后台。
  // 密码已验证通过，不计入失败锁定（不 recordFailure），仅拒发 token。
  const adminRoleRows = await db
    .select({
      role: permissionRoles.role,
      canAccessAdmin: permissionRoleDefinitions.canAccessAdmin,
    })
    .from(permissionRoles)
    .innerJoin(permissionRoleDefinitions, eq(permissionRoles.role, permissionRoleDefinitions.roleKey))
    .where(eq(permissionRoles.employeeId, staff.employeeId))
  if (!canAccessAdmin(adminRoleRows)) {
    return { success: false, message: '账号权限不足，无法登录管理后台' }
  }

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
  cookieStore.set(COOKIE_NAME, '', {
    ...(await sessionCookieOptions()),
    maxAge: 0,
  })
}

export async function changePassword(
  encryptedNewPassword: string
): Promise<{ success: boolean; message: string }> {
  const session = await getSessionFromCookie()
  if (!session) {
    return { success: false, message: '未登录' }
  }

  // 解密传输层密文（前端用 RSA 公钥加密，见 lib/password-encrypt.ts）
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

    /**
     * 查询员工信息 —— 同样**排除离职**（issue #318）。
     *
     * 只在 `login` 加过滤不够：JWT 有 24h 有效期，登录之后被标离职的人手上那张 token
     * 仍然通得过 `jwtVerify`。这里一并过滤，离职后**下一次请求**就失效
     * （返回 null ⇒ middleware 按未登录处理 ⇒ redirect `/login`）。
     *
     * 代价是「误标离职」会立刻把人踢出后台 —— 那是期望行为，而不是缺陷：
     * 改回在职即恢复，比让一个已离职账号继续持权限安全得多。
     */
    const [staff] = await db
      .select({
        employeeId: staffWechatUsers.employeeId,
        name: staffWechatUsers.name,
        phone: staffWechatUsers.phone,
      })
      .from(staffWechatUsers)
      .where(and(eq(staffWechatUsers.employeeId, employeeId), eq(staffWechatUsers.isResigned, false)))
      .limit(1)

    if (!staff) return null

    // 查询角色（仅有效的）
    const roleRows = await db
      .select({
        role: permissionRoles.role,
        roleName: permissionRoleDefinitions.name,
        canAccessAdmin: permissionRoleDefinitions.canAccessAdmin,
        isSuperAdmin: permissionRoleDefinitions.isSuperAdmin,
        isStoreManager: permissionRoleDefinitions.isStoreManager,
        scopeId: permissionRoles.scopeId,
        scopeType: orgNodes.type,
      })
      .from(permissionRoles)
      .innerJoin(permissionRoleDefinitions, eq(permissionRoles.role, permissionRoleDefinitions.roleKey))
      .leftJoin(orgNodes, eq(permissionRoles.scopeId, orgNodes.id))
      .where(eq(permissionRoles.employeeId, employeeId))

    const roles = roleRows.map(r => ({
      role: r.role as RoleType,
      roleName: r.roleName,
      canAccessAdmin: r.canAccessAdmin,
      isSuperAdmin: r.isSuperAdmin,
      isStoreManager: r.isStoreManager,
      scopeId: r.scopeId,
      scopeType: (r.scopeType ?? '门店') as '总部' | '市场' | '门店',
    }))

    // 二次闸：禁止普通员工（仅 staff 角色）持 token 访问后台——挡住登录闸上线前已发的 token，
    // 或 token 有效期内被降级为纯 staff 的用户。返回 null 触发 middleware 跳登录页。
    if (!canAccessAdmin(roles)) return null

    // 动作权限与 scope 都保留到单条角色授权维度；withPermission
    // 执行时只合并真正授予当前动作的角色 scope，防止跨角色扩权。
    const [roleActions, expandedScope] = await Promise.all([
      computeRoleActions(roles),
      expandRoleScope(roles),
    ])
    const actions = Array.from(new Set(roleActions.flat()))
    const scopedRoles = roles.map((role, index) => ({
      ...role,
      actions: roleActions[index] ?? [],
      scopeStoreIds: expandedScope.roleScopes[index]?.storeIds ?? [],
      scopeOrgNodeIds: expandedScope.roleScopes[index]?.orgNodeIds ?? [],
    }))

    return {
      employeeId: staff.employeeId,
      name: staff.name ?? '未命名',
      phone: staff.phone ?? '',
      roles: scopedRoles,
      permissions: {
        actions,
        scopeStoreIds: expandedScope.storeIds,
        scopeOrgNodeIds: expandedScope.orgNodeIds,
      },
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

    /**
     * 同样过滤离职（#318，GLM 第 2 轮 P3）—— 与 `login` / `getSessionFromCookie` 同一口径。
     * 不过滤的话，离职者手里那张 24h 内的 JWT 仍能从这里拿到真实的 `mustChange`，
     * 等于「token 还被系统部分承认」的信号，与 AC4「离职即失效」矛盾。
     */
    const [pwRow] = await db
      .select({ mustChange: adminPasswords.mustChange })
      .from(adminPasswords)
      .innerJoin(staffWechatUsers, eq(adminPasswords.employeeId, staffWechatUsers.employeeId))
      .where(and(eq(adminPasswords.employeeId, employeeId), eq(staffWechatUsers.isResigned, false)))
      .limit(1)

    return pwRow?.mustChange ?? false
  } catch {
    return false
  }
}
