const { normalize } = require('../routes/period');
const monthOf = row => row.month_key || (/^\d{6}$/.test(row.name) ? row.name.slice(0,4)+'-'+row.name.slice(4) : String(row.end_date).slice(0,7));
async function monthContext(query, allowedStores, date, payload = {}) {
  const visible = await query(`SELECT p.* FROM daily_operating_periods p WHERE p.region_id IS NULL OR EXISTS(
    SELECT 1 FROM daily_operating_period_stores ps WHERE ps.period_id=p.id AND ps.store_id=ANY($1::text[]))
    ORDER BY p.start_date DESC,p.id`, [allowedStores]);
  const months = [...new Set(visible.map(monthOf))];
  const all = months.length ? await query(`SELECT * FROM daily_operating_periods WHERE COALESCE(month_key,to_char(end_date,'YYYY-MM'))=ANY($1::text[]) ORDER BY start_date DESC,id`, [months]) : [];
  const representatives = months.map(month => all.find(p=>monthOf(p)===month && p.region_id==null) || all.find(p=>monthOf(p)===month));
  let requested = payload.periodId ? all.find(p=>p.id===payload.periodId) : null;
  if (payload.periodId && !requested) throw Error('NOT_FOUND: PK月份不存在或无权查看');
  if (!requested) requested = visible.find(p=>p.start_date<=date && p.end_date>=date) || representatives[0];
  const monthKey = requested ? monthOf(requested) : null;
  const selected = representatives.find(p=>monthOf(p)===monthKey);
  return { monthKey, period: selected ? normalize(selected) : null, periods: representatives.map(normalize), monthPeriods: all.filter(p=>monthOf(p)===monthKey) };
}
module.exports = { monthOf, monthContext };
