const pg = require('../db/pg');
const v = require('../utils/validation');
const { validatePeriod, weekForDate } = require('../utils/operating-period');
function normalize(row) {
  if (!row) return null;
  return validatePeriod({ id: row.id, name: row.name, start: row.start_date, end: row.end_date,
    weeks: row.weeks, version: row.version });
}
async function resolve(query, payload = {}) {
  const date = v.date(payload.date);
  const rows = payload.periodId
    ? await query('SELECT * FROM daily_operating_periods WHERE id=$1', [v.text(payload.periodId, 30)])
    : await query('SELECT * FROM daily_operating_periods WHERE start_date<=$1 AND end_date>=$1 ORDER BY start_date DESC', [date]);
  if (rows.length > 1) throw Error('INVALID_STATE: 经营周期配置重叠，请联系管理员');
  const period = normalize(rows[0]);
  return { date, period, week: period ? weekForDate(period, date) : null };
}
async function list(ctx) {
  const rows = await pg.query('SELECT * FROM daily_operating_periods ORDER BY start_date DESC');
  ctx.result = { periods: rows.map(normalize), ...(await resolve(pg.query, ctx.event.payload)) };
}
module.exports = { normalize, resolve, list };
