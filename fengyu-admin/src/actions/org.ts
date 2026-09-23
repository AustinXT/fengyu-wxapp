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
import { lockOrgTree } from '@/lib/invariant-locks'
import { findSubtreeOwnershipConflicts } from '@/lib/org-ancestry'

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

  // 根节点只允许总部，且只有 admin 可创建，避免非 admin 趁无父节点绕过 scope 校验。
  if (!data.parentId) {
    if (data.type !== '总部') return { success: false, message: '只有总部节点可以作为根节点' }
    if (!isAdminScope(session)) return { success: false, message: '无权创建根节点' }
  } else {
    const [parent] = await db
      .select({ type: orgNodes.type })
      .from(orgNodes)
      .where(eq(orgNodes.id, data.parentId))
      .limit(1)
    if (!parent) {
      return { success: false, message: '父节点不存在' }
    }
    const parentTypeError = validateParentType(data.type, parent.type)
    if (parentTypeError) return { success: false, message: parentTypeError }

    // scope 隔离：非 admin 只能在自己 scope 内的父节点下创建子节点
    if (!(await isNodeInScope(session, data.parentId))) {
      return { success: false, message: '无权在该节点下创建子节点' }
    }
  }

  try {
    await db.insert(orgNodes).values({
      id: data.id,
      name: data.name,
      type: data.type,
      parentId: data.parentId,
      sortOrder: data.sortOrder,
      isActive: data.isActive,
    })
  } catch (err: any) {
    if (pgErrorCode(err) === '23505') return { success: false, message: '节点编号已存在' }
    if (pgErrorCode(err) === '23503') return { success: false, message: '父节点不存在，请刷新后重试' }
    throw err
  }

  await logOperation(session, 'org.create', 'org_node', data.id, { name: data.name, type: data.type })
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
  const targetParentId = data.parentId === undefined ? current.parentId : data.parentId
  const targetType = data.type ?? current.type

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

  // scope 隔离：非 admin 只能移动到自己 scope 内的父节点下。
  if (targetParentId !== current.parentId && !(await isNodeInScope(session, targetParentId))) {
    return '无权将节点移动到该位置'
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
    outcome = structural
      ? await db.transaction(async (tx): Promise<TxOutcome> => {
        // 与员工侧的归属自洽校验共用同一把锁；取锁顺序见 lib/invariant-locks.ts（#318）
        await lockOrgTree(tx)

        // 锁内重读才是权威旧值：审计 before、层级校验、复核都依赖它
        const [locked] = await tx.select().from(orgNodes).where(eq(orgNodes.id, id)).limit(1)
        if (!locked) return { kind: 'failure', message: '节点不存在' }
        before = locked as Record<string, unknown>

        const lockedError = await validateStructuralChange(session, id, data, locked, tx)
        if (lockedError) return { kind: 'failure', message: lockedError }

        const updated = await tx.update(orgNodes).set(data).where(whereConditions)
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
        return { kind: 'written', rowCount }
      })
      : {
        kind: 'written',
        rowCount: ((await db.update(orgNodes).set(data).where(whereConditions)) as any).count ?? 0,
      }
  } catch (err: any) {
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

  await logUpdate(session, 'org.update', 'org_node', id, before, data)
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
  // scope 隔离
  if (!(await isNodeInScope(session, id))) {
    return { success: false, message: '无权操作该节点' }
  }

  // 检查子节点
  const [child] = await db
    .select({ id: orgNodes.id })
    .from(orgNodes)
    .where(eq(orgNodes.parentId, id))
    .limit(1)
  if (child) {
    return { success: false, message: '该节点下存在子节点，请先删除子节点' }
  }

  // 检查员工绑定
  const [empRef] = await db
    .select({ employeeId: staffWechatUsers.employeeId })
    .from(staffWechatUsers)
    .where(eq(staffWechatUsers.orgNodeId, id))
    .limit(1)
  if (empRef) {
    return { success: false, message: '该节点下仍有员工，请先移除员工归属' }
  }

  // 检查门店绑定
  const [storeRef] = await db
    .select({ storeId: stores.storeId })
    .from(stores)
    .where(eq(stores.orgNodeId, id))
    .limit(1)
  if (storeRef) {
    return { success: false, message: '该节点关联了门店，请先移除门店' }
  }

  // 检查权限角色引用
  const [roleRef] = await db
    .select({ id: permissionRoles.id })
    .from(permissionRoles)
    .where(eq(permissionRoles.scopeId, id))
    .limit(1)
  if (roleRef) {
    return { success: false, message: '该节点被权限角色引用，请先移除关联权限' }
  }

  // 真实删除
  try {
    const result = await db.delete(orgNodes).where(eq(orgNodes.id, id))
    if ((result as any).count === 0) {
      return { success: false, message: '节点不存在' }
    }
  } catch (err: any) {
    if (pgErrorCode(err) === '23503') {
      return { success: false, message: '该节点仍有关联数据，无法删除' }
    }
    throw err
  }

  await logOperation(session, 'org.delete', 'org_node', id)
  revalidatePath('/org')
  return { success: true, message: '节点已删除' }
  },
)
