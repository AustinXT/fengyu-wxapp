import {
  cents,
  validateMonth,
  weeklyTargets,
  validateCounts,
  countKeys,
  count,
} from './operating-target'
import { resolve, today } from './workspace'
export function expand(target: any, period: any) {
  if (!target) return null
  const weeks: any = {}
  for (const metric of ['sales', 'consumption', ...countKeys]) {
    const monthValue =
      metric === 'newCustomers' ? target.new_customers : target[metric]
    const amounts =
      monthValue == null
        ? [null, null, null, null]
        : weeklyTargets(
            monthValue,
            period.weeks
              .slice(0, 3)
              .map((w: any) => target.weeks[w.id]?.[metric] ?? null),
            countKeys.includes(metric),
          )
    period.weeks.forEach((w: any, i: number) => {
      ;(weeks[w.id] ||= {})[metric] = amounts[i]
    })
  }
  return { ...target, newCustomers: target.new_customers ?? null, weeks }
}
async function load(
  query: any,
  periodId: string,
  scope: string,
  scopeId: string,
  lock = false,
) {
  const [row] = await query(
    `SELECT * FROM daily_operating_targets WHERE period_id=$1 AND scope=$2 AND scope_id=$3${lock ? ' FOR UPDATE' : ''}`,
    [periodId, scope, scopeId],
  )
  return row || null
}
export async function writeTarget(
  transact: any,
  scopes: { scope: string; scopeId: string }[],
  payload: any,
  month: boolean,
) {
  if (
    !Number.isInteger(payload.version) ||
    payload.version < 0 ||
    !Number.isInteger(payload.periodVersion)
  )
    throw Error('INVALID_PARAMS: 缺少目标或周期版本，请重新加载')
  const scope = scopes.find(
    (s) => s.scope === payload.scope && s.scopeId === payload.scopeId,
  )
  if (!scope) throw Error('PERMISSION_DENIED: 无此目标填写权限')
  return await transact(async (query: any) => {
    const resolved = await resolve(query, {
      periodId: payload.periodId,
      date: today(),
    }, payload.regionId || null, payload.storeId || null)
    const { period, week } = resolved
    if (!period) throw Error('INVALID_STATE: 尚未配置经营周期')
    // 周期调整与目标更新共享行锁，避免提交到刚变更的周。
    const [locked] = await query(
      'SELECT version FROM daily_operating_periods WHERE id=$1 FOR SHARE',
      [period.id],
    )
    if (
      locked.version !== period.version ||
      period.version !== payload.periodVersion
    )
      throw Error('CONFLICT: 经营周期已调整，请重新加载')
    if (today() < period.start || today() > period.end)
      throw Error('INVALID_STATE: 只能设置当前经营月目标')
    await query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [
      `daily-target:${period.id}:${scope.scope}:${scope.scopeId}`,
    ])
    const old = await load(query, period.id, scope.scope, scope.scopeId, true)
    if ((old?.version || 0) !== payload.version)
      throw Error('CONFLICT: 目标已更新，请重新加载')
    let row
    if (month) {
      const counts = validateCounts(payload)
      const plan = payload.weekPlan && typeof payload.weekPlan === 'object' ? payload.weekPlan : null
      const plannedWeeks: Record<string, Record<string, number>> = {}
      if (plan) {
        for (const metric of ['sales', 'consumption', ...(counts ? countKeys : [])]) {
          const value = metric === 'newCustomers' ? payload.newCustomers : payload[metric]
          const firstThree = period.weeks.slice(0, 3).map((w: any) => {
            const raw = plan[w.id]?.[metric]
            if (raw === undefined || raw === '') throw Error('INVALID_PARAMS: 请补全前三周分摊目标')
            return metric === 'sales' || metric === 'consumption' ? cents(raw) : count(raw)
          })
          const total = metric === 'sales' || metric === 'consumption' ? cents(value, true) : count(value)
          weeklyTargets(total, firstThree, countKeys.includes(metric))
          firstThree.forEach((amount, index) => { (plannedWeeks[period.weeks[index].id] ||= {})[metric] = amount })
        }
      }
      if (old?.month_confirmed) {
        if (!counts || old.counts_month_confirmed)
          throw Error('INVALID_STATE: 本月目标已确认，不可修改')
        const mergedWeeks = { ...old.weeks, ...Object.fromEntries(Object.entries(plannedWeeks).map(([id, values]) => [id, { ...(old.weeks?.[id] || {}), ...values }])) }
        ;[row] = await query(
          `UPDATE daily_operating_targets SET visits=$4,new_customers=$5,projects=$6,
          counts_month_confirmed=true,weeks=CASE WHEN $7::jsonb IS NULL THEN weeks ELSE $7::jsonb END,version=version+1,updated_at=NOW()
          WHERE period_id=$1 AND scope=$2 AND scope_id=$3 RETURNING *`,
          [
            period.id,
            scope.scope,
            scope.scopeId,
            counts.visits,
            counts.newCustomers,
            counts.projects,
            plan ? JSON.stringify(mergedWeeks) : null,
          ],
        )
        return { ...resolved, ...scope, target: expand(row, period) }
      }
      const amounts = validateMonth(payload, scope.scope)
      ;[row] = await query(
        `INSERT INTO daily_operating_targets(period_id,scope,scope_id,sales,consumption,penalty,month_confirmed,weeks)
        VALUES($1,$2,$3,$4,$5,$6,true,$7::jsonb)
        ON CONFLICT(period_id,scope,scope_id) DO UPDATE SET sales=EXCLUDED.sales,consumption=EXCLUDED.consumption,
          penalty=EXCLUDED.penalty,month_confirmed=true,weeks=CASE WHEN $7::jsonb IS NULL THEN daily_operating_targets.weeks ELSE EXCLUDED.weeks END,version=daily_operating_targets.version+1,updated_at=NOW()
        WHERE NOT daily_operating_targets.month_confirmed RETURNING *`,
        [
          period.id,
          scope.scope,
          scope.scopeId,
          amounts.sales,
          amounts.consumption,
          amounts.penalty,
          plan ? JSON.stringify(plannedWeeks) : null,
        ],
      )
      if (counts)
        [row] = await query(
          `UPDATE daily_operating_targets SET visits=$4,new_customers=$5,projects=$6,
        counts_month_confirmed=true WHERE period_id=$1 AND scope=$2 AND scope_id=$3 RETURNING *`,
          [
            period.id,
            scope.scope,
            scope.scopeId,
            counts.visits,
            counts.newCustomers,
            counts.projects,
          ],
        )
    } else {
      if (!old?.month_confirmed) throw Error('INVALID_STATE: 请先确认本月目标')
      if (!week || week.id === period.weeks[3].id)
        throw Error('INVALID_STATE: 第4周自动取剩余金额，无需填写')
      const counts = validateCounts(payload)
      if (counts && !old.counts_month_confirmed)
        throw Error('INVALID_STATE: 请先补充确认三项月目标')
      const weeks = {
        ...old.weeks,
        [week.id]: {
          ...old.weeks[week.id],
          sales: cents(payload.sales),
          consumption: cents(payload.consumption),
          ...(counts || {}),
        },
      }
      for (const metric of ['sales', 'consumption', ...countKeys]) {
        const value =
          metric === 'newCustomers' ? old.new_customers : old[metric]
        if (value != null)
          weeklyTargets(
            value,
            period.weeks
              .slice(0, 3)
              .map((w: any) => weeks[w.id]?.[metric] ?? null),
            countKeys.includes(metric),
          )
      }
      ;[row] = await query(
        `UPDATE daily_operating_targets SET weeks=$4::jsonb,version=version+1,updated_at=NOW()
        WHERE period_id=$1 AND scope=$2 AND scope_id=$3 RETURNING *`,
        [period.id, scope.scope, scope.scopeId, JSON.stringify(weeks)],
      )
    }
    return { ...resolved, ...scope, target: expand(row, period) }
  })
}
