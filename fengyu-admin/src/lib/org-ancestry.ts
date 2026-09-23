import { sql } from 'drizzle-orm'
import { db } from '@/db'

/** 可传事务句柄 —— §AFF-03 的绑定查询与审计在同一事务里，读的必须是同一个快照 */
type SqlExecutor = Pick<typeof db, 'execute'>

/**
 * 组织树的两条递归查询，从 `actions/employees.ts` 里抽出来。
 *
 * ## 为什么要抽
 *
 * 这两条 CTE 原先内联在 `assertOwnershipConsistent` / `updateEmployee` 里。单测把 `db.execute`
 * 换成按 SQL 文本 `includes('permission_roles')` 分派的替身 —— **SQL 本身从不被检验**，于是把
 * 递归退化成单表查询（`WHERE id = $1 AND type = '门店'`）或把子树匹配退化成精确匹配
 * （`scope_id = $1`）时，全套测试照样绿。第 4 轮两个评审谱系各自独立指出了这一点，退化路径
 * 具体到语句级。
 *
 * 加 SQL 文本特征断言只能挡「结构被换掉」，挡不住「结构对、语义错」——
 * 把递归的连接方向写反（`o.parent_id = c.id` 而不是 `o.id = c.parent_id`）会让上溯变下探，
 * 而 `WITH RECURSIVE` / `UNION ALL` 等关键词一个不少。唯一能覆盖后者的是拿真 PG 跑。
 *
 * 所以走可测化这条路：函数独立 → 真库冒烟 `tests/e2e-actions/smoke-org-ancestry.mjs` 验语义
 * （连接方向、环防护、depth 取最近、子树覆盖任意深度），action 的单测则 mock 本模块专测分支
 * 逻辑。两层各管一段，不再靠一个替身同时假装两件事。
 *
 * （同一判断在 `src/lib/inventory/business.test.ts` 的威胁模型里写过：要提高保障等级应让目标
 * 可测，而不是继续加断言。）
 */

/** 最近门店祖先的查询结果。`exists: false` 与「存在但无门店祖先」必须分开 —— 前者是脏数据/并发删除，后者是合法的市场直属形态。 */
export type NearestStoreAncestor =
  | { exists: false }
  | { exists: true; storeAncestorId: string | null }

/**
 * 沿 `parent_id` 上溯，取自身及祖先中**最近**的 `type = '门店'` 节点。
 *
 * - 自身就是门店节点 → 返回自身（depth = 0）
 * - 门店下的部门 → 返回那个门店（`org.ts` 的 `validateParentType` 明确允许这种形态）
 * - 市场下的部门、或直接挂市场 → `storeAncestorId: null`（与门店维度无关）
 * - 节点不存在 → `{ exists: false }`
 *
 * `path` 数组防环：组织表理论上是树，但没有 DB 级约束禁止成环，一旦成环递归 CTE 会打满连接。
 */
export async function findNearestStoreAncestor(
  orgNodeId: string,
  executor: SqlExecutor = db,
): Promise<NearestStoreAncestor> {
  const rows = await executor.execute(sql`
    WITH RECURSIVE chain AS (
      SELECT id, parent_id, type, 0 AS depth, ARRAY[id] AS path
        FROM org_nodes WHERE id = ${orgNodeId}
      UNION ALL
      SELECT o.id, o.parent_id, o.type, c.depth + 1, c.path || o.id
        FROM org_nodes o JOIN chain c ON o.id = c.parent_id
       WHERE NOT o.id = ANY(c.path)
    )
    SELECT
      (SELECT id FROM chain WHERE type = '门店' ORDER BY depth LIMIT 1) AS store_ancestor_id,
      EXISTS (SELECT 1 FROM chain WHERE depth = 0)                      AS node_exists
  `)
  const row = (rows as unknown as Array<{ store_ancestor_id: string | null; node_exists: boolean }>)[0]
  if (!row?.node_exists) return { exists: false }
  return { exists: true, storeAncestorId: row.store_ancestor_id ?? null }
}

/**
 * 查该员工在 `rootOrgNodeId` **及其任意层级后代**上持有的角色（去重）。
 *
 * ## 子树是防御性冗余，不是在修一个真实缺陷 —— 别据此推断 scope_id 能挂部门
 *
 * 第 2 轮评审提的理由是「绑定完全可以 scope 在门店下的部门上，精确匹配会漏」。
 * 第 4 轮真库冒烟证伪了这个前提：
 *   - DB trigger `permission_validate_role_assignment_scope()` 按
 *     `permission_role_definitions.allowed_scope_types` 强制校验，现有 10 个角色的白名单
 *     全是 `{总部}` / `{市场}` / `{门店}` / 其组合 —— **没有一个含「部门」**，
 *     往部门节点插绑定直接 P0001
 *   - 生产实测：43 个 store 全部 1:1 指向门店型节点；角色绑定只落 门店 275 / 市场 58 / 总部 20；
 *     **门店型节点下零子节点**
 * 也就是说，以 `stores.org_node_id` 为根时子树恒等于 `{根自身}`，与精确匹配等价。
 *
 * 保留子树的理由只有一条：成本相同（门店节点无子节点时递归第二轮即空），而若将来
 * `allowed_scope_types` 放开到部门、或门店下开始建部门，它仍然对，精确匹配会开始静默漏。
 * 这是一笔便宜的保险，**不要**反过来把它当成「scope_id 可以挂部门」的依据。
 */
export async function findRolesBoundWithinSubtree(
  employeeId: string,
  rootOrgNodeId: string,
  executor: SqlExecutor = db,
): Promise<string[]> {
  const rows = await executor.execute(sql`
    WITH RECURSIVE subtree AS (
      SELECT id, ARRAY[id] AS path FROM org_nodes WHERE id = ${rootOrgNodeId}
      UNION ALL
      SELECT o.id, s.path || o.id
        FROM org_nodes o JOIN subtree s ON o.parent_id = s.id
       WHERE NOT o.id = ANY(s.path)
    )
    SELECT DISTINCT pr.role
      FROM permission_roles pr
     WHERE pr.employee_id = ${employeeId}
       AND pr.scope_id IN (SELECT id FROM subtree)
  `)
  return (rows as unknown as Array<{ role: string }>).map((r) => r.role)
}

/**
 * 改挂组织节点后，`rootOrgNodeId` **子树内**是否有员工的归属变得不自洽（issue #318）。
 *
 * 返回第一批冲突员工（最多 `limit` 个）；空数组 = 自洽。
 *
 * ## 为什么需要它
 *
 * #259 在员工侧加了「`org_node_id` 的最近门店祖先必须等于 `store_id` 所指门店」这条不变量，
 * 但**另一侧没守**：`updateOrgNode` 改挂父节点时不看子树下的员工。于是
 * 员工 `{storeId: A, orgNodeId: D}`（部门 D 原挂市场），管理员把 D 改挂到 B 店节点下 →
 * 员工仍属 A 店、组织却落进 B 店子树 → 通过 store / org 两维**同时出现在 A、B 两个门店的
 * scope**，正是 #259 要治的那个危害。
 *
 * 判定口径与 `findNearestStoreAncestor` **必须一致**（都是「自身及祖先中最近的门店型节点」），
 * 否则两侧各放过一半。这里为每个员工单独上溯，用 `DISTINCT ON` 取 depth 最小的那个。
 *
 * ⚠️ 只看**在职**且 `store_id` 非空的员工：
 *   - 离职员工不在任何名册里，不构成「同时出现在两个门店」
 *   - `store_id` 为空时没有「另一个门店」可言 —— 甲方 2026-09-23 拍板保持放行（#259 选项 A），
 *     所以这里也必须放过，否则两侧口径又分叉了
 *
 * 末尾用 `IS DISTINCT FROM` 而不是 `!=` 是**防御性**的：真库里 `stores.org_node_id` 为空造不出来
 * （trigger `inventory_sync_location_from_store()` 对 NULL 直接 `RAISE`，见 `db/migrations/0009`；
 * 生产 43/43 全有映射），所以两种写法当下等价 —— 但 `!=` 一旦遇到 NULL 会静默放过（fail-open），
 * 而这是条安全边界，不赌将来的导入路径。冒烟里没有对应夹具，因为 DB 造不出那个状态。
 */
export async function findSubtreeOwnershipConflicts(
  rootOrgNodeId: string,
  executor: SqlExecutor = db,
  limit = 5,
): Promise<{ employeeId: string; name: string; storeId: string }[]> {
  const rows = await executor.execute(sql`
    WITH RECURSIVE subtree AS (
      SELECT id, ARRAY[id] AS path FROM org_nodes WHERE id = ${rootOrgNodeId}
      UNION ALL
      SELECT o.id, s.path || o.id
        FROM org_nodes o JOIN subtree s ON o.parent_id = s.id
       WHERE NOT o.id = ANY(s.path)
    ),
    chain AS (
      SELECT e.employee_id, e.name, e.store_id, o.id AS cur, o.type, 0 AS depth, ARRAY[o.id] AS path
        FROM staff_wechat_users e
        JOIN org_nodes o ON o.id = e.org_node_id
       WHERE e.is_resigned = false
         AND e.store_id IS NOT NULL
         AND e.org_node_id IN (SELECT id FROM subtree)
      UNION ALL
      SELECT c.employee_id, c.name, c.store_id, p.id, p.type, c.depth + 1, c.path || p.id
        FROM chain c
        JOIN org_nodes o ON o.id = c.cur
        JOIN org_nodes p ON p.id = o.parent_id
       WHERE NOT p.id = ANY(c.path)
    ),
    nearest AS (
      SELECT DISTINCT ON (employee_id) employee_id, name, store_id, cur AS store_ancestor
        FROM chain WHERE type = '门店' ORDER BY employee_id, depth
    )
    SELECT n.employee_id, n.name, n.store_id
      FROM nearest n
      JOIN stores st ON st.store_id = n.store_id
     WHERE st.org_node_id IS DISTINCT FROM n.store_ancestor
     ORDER BY n.employee_id
     LIMIT ${limit}
  `)
  return (rows as unknown as Array<{ employee_id: string; name: string; store_id: string }>)
    .map((r) => ({ employeeId: r.employee_id, name: r.name, storeId: r.store_id }))
}
