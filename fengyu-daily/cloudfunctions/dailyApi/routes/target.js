const pg = require('../db/pg');
const v = require('../utils/validation');
const { resolve } = require('./period');
const { targetScope } = require('../utils/target-scope');
const { cents, validateMonth, weeklyTargets, validateCounts, countKeys } = require('../utils/operating-target');
function expand(target, period) {
  if (!target) return null;
  const weeks = {};
  for (const metric of ['sales', 'consumption', ...countKeys]) {
    const monthValue = metric === 'newCustomers' ? target.new_customers : target[metric];
    const amounts = monthValue == null ? [null, null, null, null] : weeklyTargets(monthValue, period.weeks.slice(0, 3).map((w) => target.weeks[w.id]?.[metric] ?? null), countKeys.includes(metric));
    period.weeks.forEach((w, i) => { (weeks[w.id] ||= {})[metric] = amounts[i]; });
  }
  return { ...target, newCustomers: target.new_customers ?? null, weeks };
}
async function load(query, periodId, scope, scopeId, lock = false) {
  const [row] = await query(`SELECT * FROM daily_operating_targets WHERE period_id=$1 AND scope=$2 AND scope_id=$3${lock ? ' FOR UPDATE' : ''}`,
    [periodId, scope, scopeId]);
  return row || null;
}
async function read(ctx) {
  const scope = await targetScope(ctx.auth, ctx.event.payload || {}, pg.query);
  const resolved = await resolve(pg.query, ctx.event.payload);
  ctx.result = { ...resolved, ...scope, reference: await require('../utils/prior-reference').reference(pg.query, ctx.auth, scope, resolved.period, resolved.week), target: resolved.period
    ? expand(await load(pg.query, resolved.period.id, scope.scope, scope.scopeId), resolved.period) : null };
}
async function write(ctx, month) {
  const payload = ctx.event.payload || {};
  if (!Number.isInteger(payload.version) || payload.version < 0 || !Number.isInteger(payload.periodVersion))
    throw Error('INVALID_PARAMS: 缺少目标或周期版本，请重新加载');
  const scope = await targetScope(ctx.auth, payload, pg.query);
  ctx.result = await pg.transaction(async (client) => {
    const query = async (sql, args) => (await client.query(sql, args)).rows;
    const resolved = await resolve(query, { periodId: payload.periodId, date: v.today() });
    const { period, week } = resolved;
    if (!period) throw Error('INVALID_STATE: 尚未配置经营周期');
    // 周期调整与目标更新共享行锁，避免提交到刚变更的周。
    const [locked] = await query('SELECT version FROM daily_operating_periods WHERE id=$1 FOR SHARE', [period.id]);
    if (locked.version !== period.version || period.version !== payload.periodVersion)
      throw Error('CONFLICT: 经营周期已调整，请重新加载');
    if (v.today() < period.start || v.today() > period.end)
      throw Error('INVALID_STATE: 只能设置当前经营月目标');
    await query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',
      [`daily-target:${period.id}:${scope.scope}:${scope.scopeId}`]);
    const old = await load(query, period.id, scope.scope, scope.scopeId, true);
    if ((old?.version || 0) !== payload.version) throw Error('CONFLICT: 目标已更新，请重新加载');
    let row;
    if (month) {
      const counts = validateCounts(payload);
      if (old?.month_confirmed) {
        if (!counts || old.counts_month_confirmed) throw Error('INVALID_STATE: 本月目标已确认，不可修改');
        [row] = await query(`UPDATE daily_operating_targets SET visits=$4,new_customers=$5,projects=$6,
          counts_month_confirmed=true,version=version+1,updated_at=NOW()
          WHERE period_id=$1 AND scope=$2 AND scope_id=$3 RETURNING *`,
        [period.id, scope.scope, scope.scopeId, counts.visits, counts.newCustomers, counts.projects]);
        return { ...resolved, ...scope, target: expand(row, period) };
      }
      const amounts = validateMonth(payload, scope.scope);
      [row] = await query(`INSERT INTO daily_operating_targets(period_id,scope,scope_id,sales,consumption,penalty,month_confirmed)
        VALUES($1,$2,$3,$4,$5,$6,true)
        ON CONFLICT(period_id,scope,scope_id) DO UPDATE SET sales=EXCLUDED.sales,consumption=EXCLUDED.consumption,
          penalty=EXCLUDED.penalty,month_confirmed=true,version=daily_operating_targets.version+1,updated_at=NOW()
        WHERE NOT daily_operating_targets.month_confirmed RETURNING *`,
      [period.id, scope.scope, scope.scopeId, amounts.sales, amounts.consumption, amounts.penalty]);
      if (counts) [row] = await query(`UPDATE daily_operating_targets SET visits=$4,new_customers=$5,projects=$6,
        counts_month_confirmed=true WHERE period_id=$1 AND scope=$2 AND scope_id=$3 RETURNING *`,
      [period.id, scope.scope, scope.scopeId, counts.visits, counts.newCustomers, counts.projects]);
    } else {
      if (!old?.month_confirmed) throw Error('INVALID_STATE: 请先确认本月目标');
      if (!week || week.id === period.weeks[3].id) throw Error('INVALID_STATE: 第4周自动取剩余金额，无需填写');
      const counts = validateCounts(payload);
      if (counts && !old.counts_month_confirmed) throw Error('INVALID_STATE: 请先补充确认三项月目标');
      const weeks = { ...old.weeks, [week.id]: { ...old.weeks[week.id], sales: cents(payload.sales), consumption: cents(payload.consumption), ...(counts || {}) } };
      for (const metric of ['sales', 'consumption', ...countKeys]) {
        const value = metric === 'newCustomers' ? old.new_customers : old[metric];
        if (value != null) weeklyTargets(value, period.weeks.slice(0, 3).map((w) => weeks[w.id]?.[metric] ?? null), countKeys.includes(metric));
      }
      [row] = await query(`UPDATE daily_operating_targets SET weeks=$4::jsonb,version=version+1,updated_at=NOW()
        WHERE period_id=$1 AND scope=$2 AND scope_id=$3 RETURNING *`,
      [period.id, scope.scope, scope.scopeId, JSON.stringify(weeks)]);
    }
    return { ...resolved, ...scope, target: expand(row, period) };
  });
}
module.exports = { read, load, expand, confirmMonth: (ctx) => write(ctx, true), saveWeek: (ctx) => write(ctx, false) };
