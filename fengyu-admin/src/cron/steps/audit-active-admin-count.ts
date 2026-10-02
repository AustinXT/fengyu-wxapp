/**
 * 活跃超级管理员数量巡检（只读告警，issue #318）
 *
 * ## 为什么需要它
 *
 * 「系统至少留一名在职超级管理员」这条不变量，#318 已经把 admin 侧的**四个**写入入口
 * 都收进了 `admin:active_count` advisory lock（`updateEmployee` 标离职 / `deleteEmployee` /
 * `revokeRole` / `updateRoleDefinition` 降级）。但 admin 不是唯一能写 `is_resigned` 的东西：
 *
 *   - `db/scripts/sync-workfine.js` 的 UPSERT 直接写 `is_resigned`，完全不碰角色也不取锁
 *     （该脚本自 2026-04-16 起业务方决定上线后不再运行，仅用于历史迁移 / 上线前刷新 ——
 *      所以这是**理论路径**，但它一旦被人手工跑起来就能破掉不变量）
 *   - 任何裸 SQL 运维操作
 *
 * 给一个已停用、且需要 MSSQL 才能跑起来的脚本加锁，既无法验证也容易改坏；而这条不变量
 * 一旦被破，后果是**没人能登录后台**（#318 的认证收紧让离职者连登录都不行）——
 * 属于「必须尽快知道」而不是「必须实时阻止」的那类。所以这里走**检测**侧：
 * 无论哪条路径破了它，第二天凌晨的巡检都会告警。
 *
 * 判据分两档：
 *   - `0` → error 级：系统已锁死，没人能进后台
 *   - `1` → warn 级：只剩一个人，他一离职/被撤权就锁死（写入侧会拒，但值得提前知道）
 *
 * 口径与 `lib/admin-guard.ts` 的 `countActiveAdmins` **必须一致**（在职 × 持超管角色，
 * 按员工去重）；这里没法直接 import 它（cron 是独立 bundle，且那边接的是 drizzle 的
 * query builder），所以抄一份等价 SQL，并由单测钉住两边的口径。
 */

import { sql } from 'drizzle-orm'
import type { Db } from '../run'
import { notifyOps } from '../lib/notify'

export interface ActiveAdminCountAuditResult {
  activeAdminCount: number
  /** `critical` = 0 人（已锁死）；`warn` = 1 人（一步之遥）；`ok` = ≥2 人 */
  level: 'ok' | 'warn' | 'critical'
}

export async function auditActiveAdminCount(db: Db): Promise<ActiveAdminCountAuditResult> {
  const rows = (await db.execute(sql`
    SELECT COUNT(DISTINCT pr.employee_id)::int AS active_admins
      FROM permission_roles pr
      JOIN permission_role_definitions d ON d.role_key = pr.role
      JOIN staff_wechat_users e ON e.employee_id = pr.employee_id
     WHERE d.is_super_admin = true
       AND e.is_resigned = false
  `)) as Array<{ active_admins: number | string }>

  const activeAdminCount = Number(rows[0]?.active_admins ?? 0) || 0
  const level = activeAdminCount === 0 ? 'critical' : activeAdminCount === 1 ? 'warn' : 'ok'

  if (level === 'ok') return { activeAdminCount, level }

  const headline = level === 'critical'
    ? '🚨 [cron-worker] 系统当前**没有**在职超级管理员 —— 无人能登录管理后台'
    : '⚠️ [cron-worker] 系统只剩 1 名在职超级管理员 —— 他一旦离职或被撤权即锁死'

  // 容器日志层告警（与其它 audit step 一致：console + operation_logs + notifyOps）
  if (level === 'critical') {
    console.error(`[cron-worker] dataIntegrity.activeAdminCount: ${activeAdminCount}`)
  } else {
    console.warn(`[cron-worker] dataIntegrity.activeAdminCount: ${activeAdminCount}`)
  }

  const detail = JSON.stringify({ activeAdminCount, level })
  await db.execute(sql`
    INSERT INTO operation_logs (action, target_type, target_id, detail, source, created_at)
    VALUES ('dataIntegrity.activeAdminCount', 'system', 'permission_roles', ${detail}::jsonb, 'cronTask', NOW())
  `)

  await notifyOps([
    headline,
    `- 在职超级管理员数：${activeAdminCount}`,
    '- 口径：持 is_super_admin 角色 × is_resigned = false，按员工去重',
    '',
    `时间：${new Date().toISOString()}`,
  ].join('\n'))

  return { activeAdminCount, level }
}
