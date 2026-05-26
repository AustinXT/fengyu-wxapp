'use server'

import { db } from '@/db'
import { sql } from 'drizzle-orm'
import { withPermission } from '@/lib/with-permission'
import { logOperation } from '@/lib/operation-log'
import {
  DEFAULT_PERMISSION_MATRIX,
  invalidatePermissionMatrixCache,
} from '@/lib/permissions'
import type { RoleType } from '@/lib/types'

const PERMISSION_MATRIX_KEY = 'permission_matrix'

/** 7 个合法角色（与 RoleType 对齐） */
const ALL_ROLES: RoleType[] = [
  'admin', 'manager', 'finance', 'hr', 'product', 'customer_mgr', 'staff',
]

/**
 * admin 必备 actions —— 删除任何一个都会让"再次进入矩阵编辑页 / 重置密码"通道被锁死。
 * saveMatrix 校验，缺失即拒绝写入（防自锁）。
 */
const ADMIN_REQUIRED_ACTIONS = [
  'system:config',         // 缺失则无法再次进入本页
  'permission:assign_admin', // 缺失则无法重新授予 admin
  'admin:reset_password',  // 缺失则无法重置员工密码
] as const

export type PermissionMatrix = Record<RoleType, string[]>

/**
 * 规范化用户提交的矩阵：补齐 7 角色 key，每个 actions 去重 + 排序 + 过滤空串。
 */
function normalizeMatrix(input: unknown): PermissionMatrix {
  const result: PermissionMatrix = {
    admin: [], manager: [], finance: [], hr: [], product: [], customer_mgr: [], staff: [],
  }
  if (!input || typeof input !== 'object') return result
  const src = input as Record<string, unknown>
  for (const role of ALL_ROLES) {
    const raw = src[role]
    if (!Array.isArray(raw)) continue
    const cleaned = [...new Set(
      raw
        .map(a => (typeof a === 'string' ? a.trim() : ''))
        .filter(Boolean),
    )].sort()
    result[role] = cleaned
  }
  return result
}

/**
 * 读取当前权限矩阵（DB 单源，缺失时回退 DEFAULT）。
 * 不走 lib/permissions.getPermissionMatrix 的进程缓存——本入口供编辑页打开时使用，
 * 必须看到最新落库值。
 */
export const getMatrix = withPermission(
  'system:config',
  async (): Promise<PermissionMatrix> => {
    try {
      const rows = await db.execute<{ value: string }>(
        sql`SELECT value FROM system_configs WHERE key = ${PERMISSION_MATRIX_KEY} LIMIT 1`,
      )
      const raw = (rows as unknown as Array<{ value: string }>)[0]?.value
      if (!raw) return normalizeMatrix(DEFAULT_PERMISSION_MATRIX)
      try {
        return normalizeMatrix(JSON.parse(raw))
      } catch {
        return normalizeMatrix(DEFAULT_PERMISSION_MATRIX)
      }
    } catch {
      return normalizeMatrix(DEFAULT_PERMISSION_MATRIX)
    }
  },
)

/**
 * 保存权限矩阵（UPSERT system_configs.permission_matrix）。
 *
 * 强校验：admin 必须保留 ADMIN_REQUIRED_ACTIONS（防自锁）。
 * 写入后立即 invalidate 进程缓存 + revalidatePath。
 */
export const saveMatrix = withPermission(
  'system:config',
  async (
    session,
    newMatrix: PermissionMatrix,
  ): Promise<{ success: boolean; message: string }> => {
    const normalized = normalizeMatrix(newMatrix)

    // 防自锁校验
    const missingAdminAction = ADMIN_REQUIRED_ACTIONS.find(
      (a) => !normalized.admin.includes(a),
    )
    if (missingAdminAction) {
      return {
        success: false,
        message: `INVALID_PARAMS: admin 角色必须保留 ${missingAdminAction}（否则将无法管理权限矩阵 / 员工密码）`,
      }
    }

    try {
      // 取 before 快照用于 diff（行不存在时按 DEFAULT 算）
      const beforeRows = await db.execute<{ value: string }>(
        sql`SELECT value FROM system_configs WHERE key = ${PERMISSION_MATRIX_KEY} LIMIT 1`,
      )
      const beforeRaw = (beforeRows as unknown as Array<{ value: string }>)[0]?.value
      const before: PermissionMatrix = beforeRaw
        ? (() => { try { return normalizeMatrix(JSON.parse(beforeRaw)) } catch { return normalizeMatrix(DEFAULT_PERMISSION_MATRIX) } })()
        : normalizeMatrix(DEFAULT_PERMISSION_MATRIX)

      const value = JSON.stringify(normalized)
      await db.execute(sql`
        INSERT INTO system_configs (key, value, updated_at)
        VALUES (${PERMISSION_MATRIX_KEY}, ${value}, NOW())
        ON CONFLICT (key) DO UPDATE SET value = ${value}, updated_at = NOW()
      `)

      await logOperation(
        session,
        'permission_matrix.update',
        'system_config',
        PERMISSION_MATRIX_KEY,
        { before, after: normalized },
      )

      invalidatePermissionMatrixCache()
      const { revalidatePath } = await import('next/cache')
      revalidatePath('/settings/permission-matrix')
      return { success: true, message: '权限矩阵已保存（30 秒内全员生效）' }
    } catch (err) {
      console.error('Save permission matrix error:', err)
      return { success: false, message: '保存失败，请稍后重试' }
    }
  },
)

/**
 * 重置权限矩阵为代码内置默认值（DELETE DB 行后自然走 fallback）。
 */
export const resetMatrix = withPermission(
  'system:config',
  async (session): Promise<{ success: boolean; message: string }> => {
    try {
      await db.execute(
        sql`DELETE FROM system_configs WHERE key = ${PERMISSION_MATRIX_KEY}`,
      )
      await logOperation(
        session,
        'permission_matrix.reset',
        'system_config',
        PERMISSION_MATRIX_KEY,
        { to: normalizeMatrix(DEFAULT_PERMISSION_MATRIX) },
      )
      invalidatePermissionMatrixCache()
      const { revalidatePath } = await import('next/cache')
      revalidatePath('/settings/permission-matrix')
      return { success: true, message: '已重置为代码默认矩阵' }
    } catch (err) {
      console.error('Reset permission matrix error:', err)
      return { success: false, message: '重置失败，请稍后重试' }
    }
  },
)
