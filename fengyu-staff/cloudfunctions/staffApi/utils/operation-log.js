

const { sanitizeDetail } = require('./pii')


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
    
    try {
      await client.query('ROLLBACK TO SAVEPOINT op_log')
    } catch (_) {  }
  }
}


async function logUpdate(client, ctx, action, targetType, targetId, before, after) {
  const changes = computeChanges(before, after)
  if (!changes) return
  return logOperation(client, ctx, action, targetType, targetId, {
    _v: 3,
    _t: 'update',
    changes,
  })
}


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
