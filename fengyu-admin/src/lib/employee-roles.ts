import { eq } from 'drizzle-orm'
import { db } from '@/db'
import { permissionRoles } from '@db/permission'

/**
 * 查某员工当前**全部**角色绑定（不按 scope 过滤）。
 *
 * ## 为什么需要它：「离职 ⇒ 角色已清空」不是一个可以押注的不变量
 *
 * `updateEmployee` 标记离职时会在事务里删光该员工的 `permission_roles`，于是很容易把
 * 「`is_resigned = true`」直接当成「没有任何角色绑定」来用。第 6 轮两个评审谱系**各自独立**
 * 指出这个推断会破，来源有两条且都真实可达：
 *   1. 写 `is_resigned = true` 的 UPDATE 与删角色的事务是**两次独立提交** ——
 *      后者失败时前者已经持久化，留下「离职行 + 有效角色」
 *   2. `db/scripts/sync-workfine.js:381` 的 UPSERT 直接 `is_resigned = EXCLUDED.is_resigned`，
 *      **完全不碰 permission_roles** —— WorkFine 那边标某人离职，此人在 admin 的角色原样留着
 *
 * 押注它的后果不是文案不准而已：复职时若沿用推断，会既提示「角色已全部撤销」（与事实相反）、
 * 又跳过旧店绑定的披露 —— 员工复职即静默恢复操作者不知情的整套旧店权限。
 *
 * 所以凡是要回答「这个员工现在有没有角色」，一律**查事实**，别从 `is_resigned` 推。
 *
 * ⚠️ 生产实测（2026-09-22）当前 `is_resigned = true` 且仍有绑定的行是 **0 条**，
 * 27 个离职员工一条绑定都没有 —— 所以这是防御而非在救火。但上面两条来源随时能产生它。
 *
 * ⚠️ 另有两个**本 PR 范围外**的相关缺口，已如实记录待独立处理：
 * `actions/auth.ts` 的 `login` 不校验 `is_resigned`，`lib/auth.ts` 取 session 时也不过滤 ——
 * 一旦出现残留绑定，离职员工能直接登录后台并行使那些权限。
 */
export async function findAllRoleBindings(
  employeeId: string,
): Promise<{ role: string; scopeId: string }[]> {
  return db
    .select({ role: permissionRoles.role, scopeId: permissionRoles.scopeId })
    .from(permissionRoles)
    .where(eq(permissionRoles.employeeId, employeeId))
}
