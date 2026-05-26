/**
 * 操作日志 helper（staff 端独立副本，对齐 admin src/lib/operation-log.ts）
 *
 * 设计要点：
 *   1. 首参为外层事务的原生 pg client（client.query 返回 { rows }）；在业务 SQL 成功后调用。
 *   2. 整体包 SAVEPOINT —— 审计日志写入失败绝不回滚业务事务（参考 utils/points.js 隔离范式）。
 *   3. operator 字段从 ctx.auth 装填（staffWfId / name / roleBindings[0]）；org 节点名取
 *      auth 中间件已注入的 roleBindings[0].scopeName，零额外 DB 往返。
 *   4. detail 入库前统一 sanitizeDetail 脱敏（与 admin 字面一致，pii.js 受 cross-end-pii-snapshot 守护）。
 *   5. source 固定 'staffApi'。
 *
 * detail 版本约定（与 admin 对齐）：
 *   - logOperation：自由 detail（创建 / 删除 / 通用操作摘要）
 *   - logUpdate   ：{ _v: 3, _t: 'update', changes: { field: { from, to } } }
 *   - logTransition：{ _v: 3, _t: 'transition', from, to, context? }
 *
 * 三端不共享代码目录（no-shared-cloudfunctions），靠约定 + 测试守护一致性。
 */

const { sanitizeDetail } = require('./pii')

/**
 * 对比 before/after，返回实际变更的字段 diff（仅遍历 after 的 key，Partial 更新只有变更字段）。
 * 返回 null 表示无实际变更。与 admin computeChanges 字面一致。
 */
function computeChanges(before, after) {
  const changes = {}
  for (const key of Object.keys(after)) {
    if (after[key] === undefined) continue
    const fromVal = before[key]
    const toVal = after[key]
    if (JSON.stringify(fromVal) !== JSON.stringify(toVal)) {
      changes[key] = { from: fromVal == null ? null : fromVal, to: toVal }
    }
  }
  return Object.keys(changes).length > 0 ? changes : null
}

/**
 * 写入操作日志（SAVEPOINT 隔离，失败不阻断业务事务）。
 *
 * @param client     外层事务原生 pg client
 * @param ctx        请求上下文（取 ctx.auth）
 * @param action     操作动作，格式 module.method（如 order.create）
 * @param targetType 目标实体类型（如 sale_order）
 * @param targetId   目标实体主键
 * @param detail     可选，结构化操作详情（入库前脱敏）
 */
async function logOperation(client, ctx, action, targetType, targetId, detail) {
  const a = (ctx && ctx.auth) || {}
  const primary = (a.roleBindings && a.roleBindings[0]) || null
  try {
    await client.query('SAVEPOINT op_log')
    await client.query(
      `INSERT INTO operation_logs
         (operator_employee_id, operator_name, operator_role, org_node_id, org_node_name,
          action, target_type, target_id, detail, source, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, 'staffApi', NOW())`,
      [
        a.staffWfId || null,
        a.name || null,
        (primary && primary.role) || (a.roles && a.roles[0]) || null,
        (primary && primary.scopeId) || null,
        (primary && primary.scopeName) || null,
        action,
        targetType,
        String(targetId),
        detail ? JSON.stringify(sanitizeDetail(detail)) : null,
      ]
    )
    await client.query('RELEASE SAVEPOINT op_log')
  } catch (e) {
    // 审计日志失败绝不阻断业务事务
    try {
      await client.query('ROLLBACK TO SAVEPOINT op_log')
    } catch (_) { /* savepoint 已失效，忽略 */ }
  }
}

/**
 * 写入更新操作日志（结构化 diff）。无实际变更则不写。
 */
async function logUpdate(client, ctx, action, targetType, targetId, before, after) {
  const changes = computeChanges(before, after)
  if (!changes) return
  return logOperation(client, ctx, action, targetType, targetId, {
    _v: 3,
    _t: 'update',
    changes,
  })
}

/**
 * 写入状态变更日志（状态流转 + 上下文）。
 */
async function logTransition(client, ctx, action, targetType, targetId, from, to, context) {
  return logOperation(client, ctx, action, targetType, targetId, {
    _v: 3,
    _t: 'transition',
    from,
    to,
    ...(context ? { context } : {}),
  })
}

module.exports = { logOperation, logUpdate, logTransition, computeChanges }
