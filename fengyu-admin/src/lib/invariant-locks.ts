import { sql } from 'drizzle-orm'
import { db } from '@/db'

/**
 * # 跨 action 的不变量锁协议（issue #318）
 *
 * 有些业务不变量的守卫**散落在多个 action** 里，彼此各自 `SELECT count(*)` 再判断。
 * 在 PG 默认的 READ COMMITTED 下这必然漏：每条语句只看已提交快照，两个不同 action
 * 的并发事务各自都读到「还有 2 个」，改的又是不同行，于是双双提交 → 不变量被破。
 *
 * #249/#259 那轮把 `updateEmployee` / `deleteEmployee` 收进了 `admin:active_count`，
 * 但 `revokeRole` 没跟上；`updateOrgNode` 改挂组织节点又能绕过员工侧的归属自洽。
 * 本模块把锁的定义与**取锁顺序**收口到一处 —— 谁要动这两个不变量，从这里取锁。
 *
 * ## 两个不变量与对应的锁
 *
 * | 锁 | 守的是什么 | 谁必须取 |
 * |---|---|---|
 * | ① `org_nodes:reparent` | **组织树形态**，以及一切按树形态做的判断：员工归属自洽（#259）、节点是否在操作者 scope 内、「节点类型 × 角色白名单 × 存量绑定」三元关系、门店↔节点映射 | `org.createOrgNode` / `updateOrgNode`（改父或改类型）/ `deleteOrgNode`、`employees.createEmployee` / `updateEmployee`（动归属或复职）、`permissions.assignRole` / `revokeRole`、`role-definitions.updateRoleDefinition`（白名单变更）、`stores.createStore` |
 * | ② `admin:active_count` | **「谁是活跃超管」这个集合** —— 由角色**绑定**与角色定义的**超管位**共同决定，所以两类写入都要取 | `employees.updateEmployee`（标离职）/ `deleteEmployee`、`permissions.assignRole` / `revokeRole`、`role-definitions.updateRoleDefinition`（capability 或白名单变更）/ `deleteRoleDefinition`、`org.updateOrgNode`（改 type） |
 *
 * ⚠️ 这张表会随功能增长，而**它不是靠自觉维护的**：
 * `invariant-locks.test.ts` 有一张逐 action 的期望清单（`EXPECTATIONS`），既断言每个 action
 * 取了哪几把锁、顺序对不对，也反向抓「取了锁却没登记」的 action。改这里记得同步那张表。
 *
 * 判断标准不是「这个 action 叫什么」，而是**「它的写入会不会让别人的守卫结论失效」**。
 * 反过来也成立：它的守卫依赖谁的写入，就得和那个写入方共锁。
 *
 * ## 不在协议里的写入方（已知、有意）
 *
 * `db/scripts/sync-workfine.js` 的 UPSERT 直接写 `is_resigned` 而不取 ② —— 那个脚本自
 * 2026-04-16 起业务方决定上线后不再运行（仅历史迁移 / 上线前刷新），且要跑起来得连
 * WorkFine 的 SQL Server。#318 给它加了**生产库硬拒绝**（`ALLOW_PROD_WORKFINE_SYNC=1`
 * 才放行），并在 cron 侧加了 `activeAdminCount` 巡检（0 人 → critical）做事后兜底。
 *
 * 归属自洽用的是**组织树那把锁**而不是新开一把：改挂父节点与判自洽是同一件事的两端 ——
 * 一边改树形态、一边依据树形态做判断，必须互斥。复用 `org_nodes:reparent` 也让
 * `org.ts` 原有的环检查自动被纳入同一条串行链。
 *
 * ## ⚠️ 锁序：必须按此顺序取，否则死锁
 *
 * ```
 * ① lockOrgTree()          组织树结构（最粗）
 * ② lockActiveAdminCount() 全局 admin 计数
 * ②' 其它业务 advisory 锁   如 createEmployee 的 `employee_id_gen`
 * ③ SELECT ... FOR UPDATE  单行（最细）
 * ```
 *
 * 粒度从粗到细。反序就是 lock ordering inversion —— PG 会抛 `40P01`，而各 action 的
 * catch 都不翻译它，用户看到 500。#249/#259 那轮已经踩过一次（`updateEmployee` 是
 * 「行锁 → advisory」而 `deleteEmployee` 是「advisory → 行锁」，两谱系各自独立报出）。
 *
 * 只取其中一把或两把时，相对顺序仍须保持 ① → ② → ③。
 */

/** 事务句柄；这两个函数只需要 `execute` */
type LockExecutor = Pick<typeof db, 'execute'>

/** 组织树结构锁的 key —— 改挂父节点与「按树形态判归属自洽」共用 */
export const ORG_TREE_LOCK_KEY = 'org_nodes:reparent'

/** 活跃超级管理员计数锁的 key */
export const ACTIVE_ADMIN_LOCK_KEY = 'admin:active_count'

/**
 * 取「组织树结构」锁（锁序 ①）。
 *
 * 改挂组织节点（`updateOrgNode`）与依据树形态判员工归属自洽
 * （`createEmployee` / `updateEmployee` 的 `assertOwnershipConsistent`）必须互斥 ——
 * 否则：改挂事务判完「子树内员工都自洽」，员工事务同时判完「我的新组织自洽」，
 * 两边提交后合成出「员工仍属 A 店、组织落进 B 店子树」，正是 #259 要禁的跨门店双重可见。
 */
export async function lockOrgTree(tx: LockExecutor) {
  await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${ORG_TREE_LOCK_KEY})::bigint)`)
}

/**
 * 取「活跃超级管理员计数」锁（锁序 ②）。
 *
 * 光把 `countActiveAdmins` 传进 `tx` 不够串行 —— 两笔并发操作分别针对 admin A、B 时
 * 各自都读到 `count = 2`、改的是不同行，双双提交 → 零管理员，系统锁死。
 * 事务化还会**放大**窗口（从「守卫→UPDATE」延长到「守卫→整个事务提交」）。
 */
export async function lockActiveAdminCount(tx: LockExecutor) {
  await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${ACTIVE_ADMIN_LOCK_KEY})::bigint)`)
}
