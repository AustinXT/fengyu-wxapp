const pg = require('../db/pg');
const v = require('../utils/validation');
const { validatePeriod, weekForDate } = require('../utils/operating-period');
function normalize(row) {
  if (!row) return null;
  return validatePeriod({ id: row.id, name: row.name, start: row.start_date, end: row.end_date,
    weeks: row.weeks, version: row.version });
}
async function marketForStore(query, storeId) {
  if (!storeId) return null;
  const [row] = await query(`WITH RECURSIVE ancestors AS (
    SELECT n.id,n.parent_id,n.type FROM stores s JOIN org_nodes n ON n.id=s.org_node_id WHERE s.store_id=$1
    UNION ALL SELECT n.id,n.parent_id,n.type FROM org_nodes n JOIN ancestors a ON a.parent_id=n.id
  ) SELECT id FROM ancestors WHERE type='市场' LIMIT 1`, [storeId]);
  return row?.id || null;
}
async function resolve(query, payload = {}, auth = null, explicitRegionId = null) {
  const date = v.date(payload.date);
  const regionId = explicitRegionId || await marketForStore(query, auth?.storeId) ||
    auth?.roleBindings?.find((binding) => binding.scopeType === '市场' && binding.actions?.includes('data_center:dashboard'))?.scopeId || null;
  const storeId = auth?.storeId || null;
  const rows = payload.periodId
    ? await query(`SELECT * FROM daily_operating_periods p WHERE p.id=$1 AND (p.region_id IS NULL OR
      ($3::text IS NOT NULL AND EXISTS(SELECT 1 FROM daily_operating_period_stores ps WHERE ps.period_id=p.id AND ps.store_id=$3)) OR
      ($3::text IS NULL AND p.region_id=$2))`, [v.text(payload.periodId, 100), regionId, storeId])
    : storeId
      ? await query(`SELECT * FROM daily_operating_periods p WHERE p.start_date<=$1 AND p.end_date>=$1
        AND (p.region_id IS NULL OR EXISTS(SELECT 1 FROM daily_operating_period_stores ps WHERE ps.period_id=p.id AND ps.store_id=$2))
        ORDER BY (p.region_id IS NOT NULL) DESC,p.start_date DESC`, [date, storeId])
      : await query(`SELECT * FROM daily_operating_periods WHERE start_date<=$1 AND end_date>=$1
        AND (region_id=$2 OR region_id IS NULL) ORDER BY (region_id=$2) DESC,start_date DESC`, [date, regionId]);
  const preferredRows = storeId
    ? rows.some((row) => row.region_id != null) ? rows.filter((row) => row.region_id != null) : rows.filter((row) => row.region_id == null)
    : rows.some((row) => row.region_id === regionId) ? rows.filter((row) => row.region_id === regionId) : rows.filter((row) => row.region_id == null);
  if (preferredRows.length > 1) throw Error('INVALID_STATE: 经营周期配置重叠，请联系管理员');
  const period = normalize(preferredRows[0]);
  return { date, period, week: period ? weekForDate(period, date) : null };
}
async function list(ctx) {
  const regionId = await marketForStore(pg.query, ctx.auth.storeId);
  const rows = ctx.auth.storeId
    ? await pg.query(`SELECT p.* FROM daily_operating_periods p WHERE p.region_id IS NULL OR EXISTS(
        SELECT 1 FROM daily_operating_period_stores ps WHERE ps.period_id=p.id AND ps.store_id=$1
      ) ORDER BY p.start_date DESC`, [ctx.auth.storeId])
    : await pg.query('SELECT * FROM daily_operating_periods WHERE region_id IS NULL OR region_id=$1 ORDER BY start_date DESC', [regionId]);
  ctx.result = { periods: rows.map(normalize), ...(await resolve(pg.query, ctx.event.payload, ctx.auth)) };
}
module.exports = { normalize, marketForStore, resolve, list };
