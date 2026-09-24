'use server'

import { db } from '@/db'
import { pgErrorCode } from '@/lib/pg-error'
import { orgNodes, stores } from '@db/org'
import { staffWechatUsers } from '@db/user'
import { permissionRoles } from '@db/permission'
import { eq, and, asc, sql } from 'drizzle-orm'
import { revalidatePath } from 'next/cache'
import type { AuthSession, OrgNode } from '@/lib/types'
import { isNodeInScope } from '@/lib/node-scope'
import { withPermission } from '@/lib/with-permission'
import { requireAdmin, isAdminScope } from '@/lib/permissions'
import { logOperation, logUpdate } from '@/lib/operation-log'
import { lockOrgTree, lockActiveAdminCount } from '@/lib/invariant-locks'
import { findSubtreeOwnershipConflicts, isNodeWithinScopeRoots } from '@/lib/org-ancestry'

const VALID_NODE_TYPES = ['总部', '市场', '门店', '部门'] as const

function validateParentType(nodeType: OrgNode['type'], parentType: OrgNode['type']): string | null {
  if (nodeType === '总部') return '总部节点必须作为根节点'
  if (parentType === '部门') {
    return nodeType === '部门' ? '部门不可嵌套' : '部门节点下不能创建子节点'
  }
  if (parentType === '门店' && nodeType !== '部门') return '门店节点下只能创建部门'
  if (nodeType === '市场' && parentType !== '总部') return '市场节点只能在总部下'
  if (nodeType === '门店' && parentType !== '市场') return '门店节点只能在市场下'
  return null
}

/**
 * 检查 targetId 是否是 nodeId 的子孙节点。
 * 递归 CTE 单条查询（path 数组防 parent 环无限递归）；`executor` 传事务句柄即可在
 * 锁内对最新已提交状态复核。
 */
async function checkIsDescendant(
  nodeId: string,
  targetId: string,
  executor: OrgExecutor = db,
): Promise<boolean> {
  if (nodeId === targetId) return true
  const client = executor
  const rows = await client.execute(sql`
    WITH RECURSIVE descendants(id, path) AS (
      SELECT ${nodeId}::text, ARRAY[${nodeId}::text]
      UNION ALL
      SELECT child.id, descendants.path || child.id
        FROM org_nodes child
        JOIN descendants ON child.parent_id = descendants.id
       WHERE NOT child.id = ANY(descendants.path)
    )
    SELECT 1 FROM descendants WHERE id = ${targetId} LIMIT 1
  `)
  return (rows as unknown as unknown[]).length > 0
}

export const getOrgNodes = withPermission(
  'org:list',
  async (): Promise<OrgNode[]> => {
  const rows = await db
    .select()
    .from(orgNodes)
    // 例外：sortOrder 手工排序权重
    .orderBy(asc(orgNodes.sortOrder))
  return rows.map((row) => ({
    id: row.id,
    name: row.name,
    type: row.type,
    parentId: row.parentId,
    sortOrder: row.sortOrder,
    isActive: row.isActive,
    createdAt: row.createdAt?.toISOString() ?? '',
    updatedAt: row.updatedAt?.toISOString() ?? '',
  }))
  },
)

export const createOrgNode = withPermission(
  'org:create',
  async (
    session,
    data: {
      id: string
      name: string
      type: OrgNode['type']
      parentId: string | null
      sortOrder: number
      isActive: boolean
    },
  ): Promise<{ success: boolean; message: string }> => {
  // 校验 type 是否有效
  if (!VALID_NODE_TYPES.includes(data.type as typeof VALID_NODE_TYPES[number])) {
    return { success: false, message: `无效的节点类型: ${data.type}` }
  }

  /**
   * 根节点只允许总部，且只有 admin 可创建，避免非 admin 趁无父节点绕过 scope 校验。
   *
   * ⚠️ 判据是「显式为 null / undefined」而不是 `!data.parentId` —— 后者会把 `''` 也当成
   * 「建根节点」（GLM 第 6 轮 P3）。空串该走「父节点不存在」那条路，
   * 而不是悄悄进入只校验 type + admin 的根分支。
   */
  if (data.parentId === null || data.parentId === undefined) {
    if (data.type !== '总部') return { success: false, message: '只有总部节点可以作为根节点' }
    if (!isAdminScope(session)) return { success: false, message: '无权创建根节点' }
  } else if (!(await isNodeInScope(session, data.parentId))) {
    // scope 隔离：非 admin 只能在自己 scope 内的父节点下创建子节点（纯内存判据，先拒省事务）
    return { success: false, message: '无权在该节点下创建子节点' }
  }

  /**
   * ## 创建也要取组织树锁（#318 第 3 轮，codex P2）
   *
   * 父节点类型原先是**无锁**读的，于是与 `updateOrgNode` 改类型并发时能合成出非法树：
   * 建子节点的事务读到父节点是「市场」，改类型的事务查直接子节点时这个子节点还没提交，
   * 两边都放行 → 提交后成了「部门下挂门店」。改类型那侧现在会复核存量子节点
   * （`validateTypeChangeImpact`），但只有两侧**共用同一把锁**才真的闭合。
   *
   * 锁内重读父节点类型 —— 事务外那次读到的类型可能已经变了。
   */
  type CreateOutcome = { ok: true } | { ok: false; message: string }
  let created: CreateOutcome
  try {
    created = await db.transaction(async (tx): Promise<CreateOutcome> => {
      await lockOrgTree(tx)

      if (data.parentId) {
        const [parent] = await tx
          .select({ type: orgNodes.type })
          .from(orgNodes)
          .where(eq(orgNodes.id, data.parentId))
          .limit(1)
        if (!parent) return { ok: false, message: '父节点不存在' }
        const parentTypeError = validateParentType(data.type, parent.type)
        if (parentTypeError) return { ok: false, message: parentTypeError }

        // 父节点是否还在管辖范围内，也要按**当前树**复判（codex 第 4 轮 P1）
        if (!isAdminScope(session)) {
          const scopeRoots = session.roles.map((role) => role.scopeId)
          if (!(await isNodeWithinScopeRoots(data.parentId, scopeRoots, tx))) {
            return { ok: false, message: '无权在该节点下创建子节点' }
          }
        }
      }

      await tx.insert(orgNodes).values({
        id: data.id,
        name: data.name,
        type: data.type,
        parentId: data.parentId,
        sortOrder: data.sortOrder,
        isActive: data.isActive,
      })
      await logOperation(session, 'org.create', 'org_node', data.id, { name: data.name, type: data.type }, tx)
      return { ok: true }
    })
  } catch (err: any) {
    if (pgErrorCode(err) === '23505') return { success: false, message: '节点编号已存在' }
    if (pgErrorCode(err) === '23503') return { success: false, message: '父节点不存在，请刷新后重试' }
    throw err
  }

  if (!created.ok) return { success: false, message: created.message }

  revalidatePath('/org')
  return { success: true, message: '节点创建成功' }
  },
)

/**
 * 事务内回滚哨兵：改挂后子树员工归属不自洽。
 * 外层 catch 按 message 匹配后转成友好文案（已登记进
 * `cross-end-error-codes-snapshot.test.js` 的 `TX_SENTINELS` 白名单）。
 */
const ORG_OWNERSHIP_CONFLICT = 'ORG_OWNERSHIP_CONFLICT'

/** 全局 `db` 与事务句柄的公共读取面 —— 层级校验事务内外各跑一次，两处共用一份实现 */
type OrgExecutor = typeof db | Parameters<Parameters<typeof db.transaction>[0]>[0]

/**
 * 结构性变更（改父节点 / 改类型）的层级校验。返回错误文案；`null` = 通过。
 *
 * 抽成函数是因为它要跑**两次**：事务外一次当早拒（省掉开事务的成本），锁内一次才算权威。
 * 只在事务外跑不行 —— 目标父节点的存在性/类型、以及本节点自己的 `parentId`/`type`
 * 都可能在校验与写入之间被并发改掉（GLM 第 1 轮 P3）。
 *
 * `current` 必须是**调用方那一侧读到的**当前行：事务外传事务外快照，锁内传锁内重读的行。
 * 别把锁内的判断建在事务外的快照上 —— 「同一份状态两套真相」是 #249/#259 那轮几乎所有
 * 缺陷的共同根因。
 */
async function validateStructuralChange(
  session: AuthSession,
  id: string,
  data: { parentId?: string | null; type?: OrgNode['type'] },
  current: { parentId: string | null; type: OrgNode['type'] },
  executor: OrgExecutor,
): Promise<string | null> {
  /**
   * ⚠️ 空串**不是**「移动为根节点」。`data.parentId === ''` 时：`!targetParentId` 为真 →
   * 落进根分支的规则（总部 + admin 即放行）→ UPDATE 写 `parent_id = ''` → 撞 FK `23503`
   * 而 catch 不认它 → 用户看到 500（GLM 第 10 轮 P3）。
   * 与 `createOrgNode` 的判据保持一致：只有显式 `null` 才是根，空串按「父节点不存在」拒。
   */
  if (data.parentId === '') return '目标父节点不存在'

  const targetParentId = data.parentId === undefined ? current.parentId : data.parentId
  const targetType = data.type ?? current.type

  /**
   * 被编辑节点**自身**是否还在操作者管辖范围内 —— 按**当前树**判（#318 第 3 轮，两谱系共识）。
   *
   * ⚠️ 这里刻意**不**复用 `isNodeInScope`：它判的是 `session.permissions.scopeOrgNodeIds`
   * 这份在构造 session 时展开好的内存集合，与「现在的树」无关，锁内再调一次是 **no-op**
   * （两个谱系都建议「锁内重跑 isNodeInScope」，那个改法测不出也防不住）。
   * 用角色绑定的根节点去查当前树才真的能发现「并发把节点挪出了我的 scope」。
   */
  if (!isAdminScope(session)) {
    // 用角色绑定的**根节点**（不是展开后的集合）去查树；展开集合本身就是那份过期快照
    const scopeRoots = session.roles.map((role) => role.scopeId)
    if (!(await isNodeWithinScopeRoots(id, scopeRoots, executor))) {
      return '无权编辑该节点'
    }
  }

  if (data.type !== undefined && data.type !== current.type) {
    const impactError = await validateTypeChangeImpact(id, data.type, executor)
    if (impactError) return impactError
  }

  // 不能将节点移动到自己或自己的子孙节点下（防止循环引用）
  if (targetParentId && targetParentId !== current.parentId) {
    if (await checkIsDescendant(id, targetParentId, executor)) {
      return '不能将节点移动到自己的子节点下'
    }
  }

  if (!targetParentId) {
    if (targetType !== '总部') return '只有总部节点可以作为根节点'
    if (!isAdminScope(session)) return '无权将节点移动为根节点'
    return null
  }

  const [newParent] = await executor
    .select({ type: orgNodes.type })
    .from(orgNodes)
    .where(eq(orgNodes.id, targetParentId))
    .limit(1)
  if (!newParent) return '目标父节点不存在'

  const parentTypeError = validateParentType(targetType, newParent.type)
  if (parentTypeError) return parentTypeError

  /**
   * scope 隔离：非 admin 只能移动到自己 scope 内的父节点下。
   *
   * 两条判据都要：`isNodeInScope` 是纯内存的**早拒**，`isNodeWithinScopeRoots` 按**当前树**判
   * —— 目标父节点也可能在 session 构造之后被挪出操作者的管辖范围（codex 第 4 轮 P1）。
   * 只判前者的话，锁内那次等于没判（同一纯函数同一入参）。
   */
  if (targetParentId !== current.parentId) {
    if (!(await isNodeInScope(session, targetParentId))) return '无权将节点移动到该位置'
    if (!isAdminScope(session)) {
      const scopeRoots = session.roles.map((role) => role.scopeId)
      if (!(await isNodeWithinScopeRoots(targetParentId, scopeRoots, executor))) {
        return '无权将节点移动到该位置'
      }
    }
  }
  return null
}

/**
 * 改 `type` 的**连带影响**校验（#318 第 3 轮，codex P1/P2）。返回错误文案；`null` = 通过。
 *
 * `validateParentType` 只管「新类型 × 父节点类型」这一对，剩下三样它看不见 ——
 * 而这三样在**创建**路径上都有守卫，改类型这条路上一个都没有，典型的「同一条规则只守了一侧」：
 *
 * 1. **已有直接子节点**：市场（下挂门店）改成部门 → 成了「部门下挂门店」，
 *    而 `validateParentType` 只在新建子节点时判，存量子节点不回溯。
 * 2. **已有角色绑定**：门店节点上有 `permission_roles` 时改成部门 → 留下
 *    「角色绑定挂部门节点」，DB trigger `permission_validate_role_assignment_scope()`
 *    只在绑定行 INSERT 时按当时的 `allowed_scope_types` 校验，改定义/改节点类型都不回溯。
 * 3. **已有门店映射**：`stores.org_node_id` 指向本节点时把它从门店改成别的类型 →
 *    门店失去组织挂载点（`inventory_sync_location_from_store()` 明确要求门店必须指向
 *    市场下的门店型节点，而它只在写 `stores` 时触发，改 `org_nodes.type` 绕开它）。
 */
async function validateTypeChangeImpact(
  id: string,
  newType: OrgNode['type'],
  executor: OrgExecutor,
): Promise<string | null> {
  const children = await executor
    .select({ id: orgNodes.id, name: orgNodes.name, type: orgNodes.type })
    .from(orgNodes)
    .where(eq(orgNodes.parentId, id))
  for (const child of children) {
    const err = validateParentType(child.type, newType)
    if (err) return `该节点下已有子节点「${child.name}」，改为「${newType}」后层级不合法：${err}`
  }

  const [mappedStore] = await executor
    .select({ storeName: stores.storeName })
    .from(stores)
    .where(eq(stores.orgNodeId, id))
    .limit(1)
  if (mappedStore && newType !== '门店') {
    return `门店「${mappedStore.storeName}」挂载在该节点上，不能改为「${newType}」，请先调整门店的组织归属`
  }

  /**
   * 绑定这一侧按角色定义的 `allowed_scope_types` 判。走原生 SQL 是因为
   * `permission_role_definitions` 的 `allowed_scope_types` 是数组列，
   * 用 `= ANY` 判包含比拼 drizzle 的数组算子更直观。
   */
  const bindingRows = await executor.execute(sql`
    SELECT d.name AS role_name
      FROM permission_roles pr
      JOIN permission_role_definitions d ON d.role_key = pr.role
     WHERE pr.scope_id = ${id}
       AND NOT (${newType} = ANY(d.allowed_scope_types))
     LIMIT 1
  `)
  const blocked = (bindingRows as unknown as Array<{ role_name: string }>)[0]
  if (blocked) {
    return `该节点上已有「${blocked.role_name}」角色授权，不能改为「${newType}」（该角色不允许绑定此层级），请先撤销授权`
  }
  return null
}

export const updateOrgNode = withPermission(
  'org:update',
  async (
    session,
    id: string,
    data: Partial<{
      name: string
      type: OrgNode['type']
      parentId: string | null
      sortOrder: number
      isActive: boolean
    }>,
    /** 乐观锁：提交时携带的 updated_at */
    expectedUpdatedAt?: string,
  ): Promise<{ success: boolean; message: string }> => {
  // 校验 type 是否有效
  if (data.type && !VALID_NODE_TYPES.includes(data.type as typeof VALID_NODE_TYPES[number])) {
    return { success: false, message: `无效的节点类型: ${data.type}` }
  }

  // scope 隔离：非 admin 只能编辑自己 scope 内的节点
  if (!(await isNodeInScope(session, id))) {
    return { success: false, message: '无权编辑该节点' }
  }

  // 事务外快照：给早拒与审计 before 兜底；结构性变更会在锁内换成重读的那份
  const [preTxBefore] = await db.select().from(orgNodes).where(eq(orgNodes.id, id)).limit(1)
  if (!preTxBefore) return { success: false, message: '节点不存在' }

  /**
   * ## 什么算「结构性变更」——判据只看 `!== undefined`（#318）
   *
   * 改 `parentId` **或** `type` 都会改变「员工 org 节点的最近门店祖先」这个判据：
   *   - 改父：部门 D 从市场挪进 B 店子树 → 挂 D 的员工多出一个门店祖先
   *   - 改类型：市场下的部门 D 直接改成「门店」→ 挂 D 的员工的最近门店祖先变成 D 自己
   *     （生产 74 人挂部门型节点，正是这个形态；两个评审谱系第 1 轮都报了这条）
   *
   * ⚠️ 判据**不与事务外旧值比较**（原先是 `data.parentId !== before.parentId`）：
   *   - 那是拿事务外快照当真相 —— 并发下「看起来没变」也可能实际完成了改挂，
   *     于是走进无锁的 UPDATE 分支，把节点改回去且不复核
   *   - 真要比也得等锁内读到旧值才知道，那时再取锁顺序就反了
   * 多开一次事务 + 一把纯 advisory 锁的成本可忽略，换掉一整类 TOCTOU。
   */
  const structural = data.parentId !== undefined || data.type !== undefined

  /**
   * ## 写库字段走**显式白名单**（#318 第 8 轮 codex P1）
   *
   * `data: Partial<{…}>` 只是编译期类型；Server Action 是可直接调用的端点、入参原样到达。
   * 裸 `.set(data)` 时客户端可以多塞 `updatedAt` —— 把它写成一个旧时刻，
   * 那么**持旧版本的请求也能命中 CAS**，乐观锁整体失效；`id` / `createdAt` 同理。
   * 与 `updateStore` / `updateEmployee` 同一条规则（#249/#259 起）。
   *
   * ⚠️ 新增可编辑字段必须在这里登记一行，否则会静默不生效（比静默写坏安全得多）。
   * `structural` 的判据用的是**原始入参**：多塞的键不参与结构性判断，也就进不了锁内路径。
   */
  const updateData: Record<string, unknown> = {}
  for (const key of ['name', 'type', 'parentId', 'sortOrder', 'isActive'] as const) {
    if (data[key] !== undefined) updateData[key] = data[key]
  }

  if (structural) {
    // 早拒：省掉开事务的成本。**权威版本在锁内**，这里判过的锁内一律重判。
    const preTxError = await validateStructuralChange(session, id, data, preTxBefore, db)
    if (preTxError) return { success: false, message: preTxError }
  }

  const whereConditions = expectedUpdatedAt
    ? and(eq(orgNodes.id, id), sql`date_trunc('milliseconds', ${orgNodes.updatedAt}) = ${expectedUpdatedAt}`)
    : eq(orgNodes.id, id)

  /** 事务出口：要么写了（带 rowCount），要么带着文案失败（此时还没写任何东西） */
  type TxOutcome = { kind: 'written'; rowCount: number } | { kind: 'failure'; message: string }

  let before: Record<string, unknown> = preTxBefore as Record<string, unknown>
  let ownershipConflicts: { employeeId: string; name: string; storeId: string }[] = []
  let ownershipConflictTotal = 0
  let outcome: TxOutcome
  try {
    /**
     * ## 两条路径都走事务 + ① 锁（#318 第 9 轮 GLM P2）
     *
     * 非结构性更新（改名 / 排序 / 启停）**不改树形态**，本来不需要 ①。但它的 scope 判定
     * 依赖树形态：事务外那次 `isNodeInScope` 是纯内存的（session 构造时展开的快照，
     * 窗口 = 24h JWT）。反例无需并发：
     *   ① hr 登录，scope 集合含部门 X；② admin 把 X 改挂到另一个市场（结构性路径，合法提交）；
     *   ③ hr 在 JWT 有效期内改 X 的名字 → 旧集合放行 → 越管辖范围写入。
     * 要按当前树判就得有个一致的快照，取 ① 最省事，顺带让**审计也进事务**
     * （非结构性路径原先在事务外写审计，写成功、审计抛错时用户看到失败但改名已生效 ——
     * create / assign / revoke / 结构性路径都已收口，全仓就剩这一处）。
     *
     * 代价是改名也开一个事务 + 一把纯 advisory 锁 —— 组织节点编辑是低频管理操作，可忽略。
     */
    outcome = await db.transaction(async (tx): Promise<TxOutcome> => {
      if (structural) return await runStructuralUpdate(tx)

      await lockOrgTree(tx)
      if (!isAdminScope(session)) {
        const scopeRoots = session.roles.map((role) => role.scopeId)
        if (!(await isNodeWithinScopeRoots(id, scopeRoots, tx))) {
          return { kind: 'failure', message: '无权编辑该节点' }
        }
      }
      const [locked] = await tx.select().from(orgNodes).where(eq(orgNodes.id, id)).limit(1)
      if (!locked) return { kind: 'failure', message: '节点不存在' }
      before = locked as Record<string, unknown>

      const updated = await tx.update(orgNodes).set(updateData).where(whereConditions)
      const rowCount = (updated as any).count ?? 0
      if (rowCount === 0) return { kind: 'written', rowCount: 0 }

      await logUpdate(session, 'org.update', 'org_node', id, before, updateData, tx)
      return { kind: 'written', rowCount }
    })

    /** 结构性路径（改父 / 改类型）的事务体 —— 由上面那个事务回调按 `structural` 分派进来 */
    async function runStructuralUpdate(
      tx: Parameters<Parameters<typeof db.transaction>[0]>[0],
    ): Promise<TxOutcome> {
      // 与员工侧的归属自洽校验共用同一把锁；取锁顺序见 lib/invariant-locks.ts（#318）
      await lockOrgTree(tx)
      /**
       * 改 `type` 还要取 ② —— 它判的「节点上的角色绑定是否被新类型允许」这个三元关系
       * （节点类型 × 角色白名单 × 存量绑定）同时被 `assignRole` 与
       * `updateRoleDefinition` 改白名单读写，而那两条路径取的是 ②（codex 第 4 轮 P1）。
       * 只取 ① 的话：「门店→市场」与「白名单 门店+市场 → 仅门店」并发各自按旧状态通过，
       * 提交后留下一条「角色不允许挂在市场节点」的存量授权，而权限计算会一直采用它。
       * 顺序必须 ① → ②（见 lib/invariant-locks.ts），反了就是 40P01。
       */
      if (data.type !== undefined) await lockActiveAdminCount(tx)

      // 锁内重读才是权威旧值：审计 before、层级校验、复核都依赖它
      const [locked] = await tx.select().from(orgNodes).where(eq(orgNodes.id, id)).limit(1)
      if (!locked) return { kind: 'failure', message: '节点不存在' }
      before = locked as Record<string, unknown>

      const lockedError = await validateStructuralChange(session, id, data, locked, tx)
      if (lockedError) return { kind: 'failure', message: lockedError }

      const updated = await tx.update(orgNodes).set(updateData).where(whereConditions)
      const rowCount = (updated as any).count ?? 0
      if (rowCount === 0) return { kind: 'written', rowCount: 0 }

      /**
       * ## 改完必须复核子树内员工的归属自洽（issue #318）
       *
       * #259 只在**员工侧**加了「`org_node_id` 的最近门店祖先 = `store_id` 所指门店」，
       * 这一侧没守：把部门 D 从市场改挂到 B 店节点下，挂着 D 的员工就成了
       * 「仍属 A 店、组织却在 B 店子树」—— 通过 store / org 两维同时出现在两个门店的
       * scope，正是 #259 要禁的危害。
       *
       * **先 UPDATE 再复核**：这样查的是改完**之后**的真实树形态，不必在 SQL 里模拟
       * 新父节点或新类型。不自洽就抛哨兵回滚，等价于拒绝这次变更。
       *
       * 锁已在事务开头取到，而员工侧的归属校验取的是**同一把** —— 所以「这边判完子树自洽」
       * 与「员工那边判完自己的新组织自洽」不会并发交错后合成出不自洽状态。
       */
      const found = await findSubtreeOwnershipConflicts(id, tx)
      if (found.conflicts.length > 0) {
        ownershipConflicts = found.conflicts
        ownershipConflictTotal = found.total
        throw new Error(ORG_OWNERSHIP_CONFLICT)
      }

      // 审计与写入同生共死（GLM 第 5 轮 P3：create/assign/revoke 都收进事务了，就差这里）
      await logUpdate(session, 'org.update', 'org_node', id, before, updateData, tx)
      return { kind: 'written', rowCount }
    }
  } catch (err: any) {
    /**
     * FK 兜底：目标父节点在校验与写入之间被并发删除（`deleteOrgNode` 现在取了同一把 ①，
     * 但 DB 层的裸 SQL 运维仍可能造成）。`createOrgNode` 一直有这条，改挂这侧原先没有 →
     * 裸抛 500（GLM 第 10 轮 P3）。
     */
    if (pgErrorCode(err) === '23503') {
      return { success: false, message: '目标父节点不存在，请刷新后重试' }
    }
    if (err instanceof Error && err.message === ORG_OWNERSHIP_CONFLICT) {
      // 姓名兜底成工号：`name` 理论上非空，但空串会渲染出孤零零的顿号（GLM 第 1 轮 P3）
      const who = ownershipConflicts.map((c) => c.name?.trim() || c.employeeId).join('、')
      // 名单被 limit 截断时告诉总数，否则管理员改完 5 个再点一次又冒出 5 个
      const more = ownershipConflictTotal > ownershipConflicts.length
        ? `（共 ${ownershipConflictTotal} 人）`
        : ''
      return {
        success: false,
        message: `变更后这些员工的门店与组织归属将不一致，请先调整他们的归属：${who}${more}`,
      }
    }
    throw err
  }

  if (outcome.kind === 'failure') return { success: false, message: outcome.message }

  if (outcome.rowCount === 0) {
    return {
      success: false,
      message: expectedUpdatedAt ? '数据已被其他人修改，请刷新后重试' : '节点不存在',
    }
  }

  // 审计两条路径都在事务内写过了
  revalidatePath('/org')
  return { success: true, message: '节点已更新' }
  },
)

export const deleteOrgNode = withPermission(
  'org:delete',
  async (
    session,
    id: string,
  ): Promise<{ success: boolean; message: string }> => {
  requireAdmin(session)
  // scope 隔离（纯内存早拒；锁内按当前树复判）
  if (!(await isNodeInScope(session, id))) {
    return { success: false, message: '无权操作该节点' }
  }

  /**
   * ## 删除也要取组织树锁（#318 第 5 轮，GLM P2）
   *
   * 删除同样是**改变树形态**的写入，却是协议里唯一漏网的入口。不取锁的后果不只是
   * 「守卫失效」，而是**两条用户可见的 500**：
   *   - `updateOrgNode` 在锁内读到了目标父节点，本 action 并发把它删掉 →
   *     那边的 UPDATE 撞 FK `23503`，而它的 catch 只认 `ORG_OWNERSHIP_CONFLICT` → 裸抛
   *   - `assignRole` 在锁内确认节点存在后 INSERT，本 action 并发删掉它 → scope 侧 FK `23503`，
   *     不匹配它 catch 里的 `permission_roles_employee_id_` 前缀 → 裸抛
   * 四项引用检查全部收进锁内重跑 —— 事务外那几次只是早拒。
   */
  type DeleteOutcome = { ok: true } | { ok: false; message: string }
  let outcome: DeleteOutcome
  try {
    outcome = await db.transaction(async (tx): Promise<DeleteOutcome> => {
      await lockOrgTree(tx)

      if (!isAdminScope(session)) {
        const scopeRoots = session.roles.map((role) => role.scopeId)
        if (!(await isNodeWithinScopeRoots(id, scopeRoots, tx))) {
          return { ok: false, message: '无权操作该节点' }
        }
      }

      const [child] = await tx
        .select({ id: orgNodes.id })
        .from(orgNodes)
        .where(eq(orgNodes.parentId, id))
        .limit(1)
      if (child) return { ok: false, message: '该节点下存在子节点，请先删除子节点' }

      const [empRef] = await tx
        .select({ employeeId: staffWechatUsers.employeeId })
        .from(staffWechatUsers)
        .where(eq(staffWechatUsers.orgNodeId, id))
        .limit(1)
      if (empRef) return { ok: false, message: '该节点下仍有员工，请先移除员工归属' }

      const [storeRef] = await tx
        .select({ storeId: stores.storeId })
        .from(stores)
        .where(eq(stores.orgNodeId, id))
        .limit(1)
      if (storeRef) return { ok: false, message: '该节点关联了门店，请先移除门店' }

      const [roleRef] = await tx
        .select({ id: permissionRoles.id })
        .from(permissionRoles)
        .where(eq(permissionRoles.scopeId, id))
        .limit(1)
      if (roleRef) return { ok: false, message: '该节点被权限角色引用，请先移除关联权限' }

      const result = await tx.delete(orgNodes).where(eq(orgNodes.id, id))
      if ((result as any).count === 0) return { ok: false, message: '节点不存在' }

      // 审计与删除同生共死（与 create 侧一致）
      await logOperation(session, 'org.delete', 'org_node', id, undefined, tx)
      return { ok: true }
    })
  } catch (err: any) {
    if (pgErrorCode(err) === '23503') {
      return { success: false, message: '该节点仍有关联数据，无法删除' }
    }
    throw err
  }

  if (!outcome.ok) return { success: false, message: outcome.message }

  revalidatePath('/org')
  return { success: true, message: '节点已删除' }
  },
)
