import { db } from '@/db'
import { operationLogs } from '@db/operation-log'
import type { AuthSession } from './types'
import { sanitizeDetail } from './pii'

type OperationLogExecutor = Pick<typeof db, 'select' | 'insert'>

/**
 * 对比 before/after，返回实际变更的字段 diff。
 * 只遍历 after 中的 key（Partial 更新只有变更字段）。
 * 返回 null 表示无实际变更。
 */
export function computeChanges(
  before: Record<string, unknown>,
  after: Record<string, unknown>,
): Record<string, { from: unknown; to: unknown }> | null {
  const changes: Record<string, { from: unknown; to: unknown }> = {}
  for (const key of Object.keys(after)) {
    if (after[key] === undefined) continue
    const fromVal = before[key]
    const toVal = after[key]
    if (JSON.stringify(fromVal) !== JSON.stringify(toVal)) {
      changes[key] = { from: fromVal ?? null, to: toVal }
    }
  }
  return Object.keys(changes).length > 0 ? changes : null
}

/**
 * 写入操作日志
 *
 * orgNodeId/orgNodeName 从 session 的主要角色 scopeId 中获取
 */
export async function logOperation(
  session: AuthSession,
  action: string,
  targetType: string,
  targetId: string,
  detail?: Record<string, unknown>,
  executor: OperationLogExecutor = db,
) {
  const primaryRole = session.roles[0]

  // 从角色 scope 中获取组织节点上下文
  let orgNodeId: string | null = null
  let orgNodeName: string | null = null
  if (primaryRole?.scopeId) {
    try {
      const { orgNodes } = await import('@db/org')
      const { eq } = await import('drizzle-orm')
      const [node] = await executor
        .select({ id: orgNodes.id, name: orgNodes.name })
        .from(orgNodes)
        .where(eq(orgNodes.id, primaryRole.scopeId))
        .limit(1)
      if (node) {
        orgNodeId = node.id
        orgNodeName = node.name
      }
    } catch {
      /**
       * 查询失败不影响日志写入 —— 但**在事务内调用时这个吞异常是有毒的**：
       * PG 里一条失败语句会把整个事务标记为 aborted（`25P02`），后续语句一律报错，
       * 吞掉 JS 异常并不能让事务恢复。于是这里「优雅降级」的结果是下面那条 INSERT 必然失败、
       * 整笔业务回滚，而调用方看到的是一个跟组织节点毫无关系的错误。
       *
       * 现状可接受的理由：这条查询是 `SELECT … WHERE id = $1 LIMIT 1`，正常情况下不会失败；
       * 真会失败的场景（连接断、表被删）本来就救不回来。
       * 若将来有更多事务内调用，正解是**只在非事务（executor === db）时吞**，
       * 传了 tx 就让它抛出去。
       * 发现于 #249/#259 的事务化改造（2026-09-22），未改共用模块行为。
       */
    }
  }

  await executor.insert(operationLogs).values({
    operatorEmployeeId: session.employeeId,
    operatorName: session.name,
    operatorRole: primaryRole?.role ?? null,
    orgNodeId,
    orgNodeName,
    action,
    targetType,
    targetId,
    detail: detail ? sanitizeDetail(detail) : null,
    source: 'adminApi',
  })
}

/**
 * 写入更新操作日志（结构化 diff）
 *
 * detail 格式：{ _v: 3, _t: 'update', changes: { field: { from, to } } }
 * _v: 3 起 detail 在 logOperation 内统一跑 sanitizeDetail（敏感 PII 字段入库前脱敏）
 */
export async function logUpdate(
  session: AuthSession,
  action: string,
  targetType: string,
  targetId: string,
  before: Record<string, unknown>,
  after: Record<string, unknown>,
  executor: OperationLogExecutor = db,
) {
  const changes = computeChanges(before, after)
  if (!changes) return
  await logOperation(session, action, targetType, targetId, {
    _v: 3,
    _t: 'update',
    changes,
  }, executor)
}

/**
 * 写入状态变更日志（状态流转 + 上下文）
 *
 * detail 格式：{ _v: 3, _t: 'transition', from, to, context? }
 * _v: 3 起 detail 在 logOperation 内统一跑 sanitizeDetail
 */
export async function logTransition(
  session: AuthSession,
  action: string,
  targetType: string,
  targetId: string,
  from: string,
  to: string,
  context?: Record<string, unknown>,
) {
  await logOperation(session, action, targetType, targetId, {
    _v: 3,
    _t: 'transition',
    from,
    to,
    ...(context ? { context } : {}),
  })
}
