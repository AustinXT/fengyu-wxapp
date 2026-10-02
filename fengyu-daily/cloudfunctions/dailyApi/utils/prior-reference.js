const { normalize } = require('../routes/period');
// 优先按经营月名称的年份对应；名称未含年份时，只匹配去年相同开始月日。
// 配置不明确或没有对应周期时返回空，不用演示金额替代实际数据。
async function reference(query, auth, scope, period, week) {
  if (!period) return null;
  const year = Number(period.start.slice(0, 4)), priorName = period.name.replace(String(year), String(year - 1));
  const rows = await query(`SELECT * FROM daily_operating_periods WHERE EXTRACT(YEAR FROM start_date)=$1
    AND (name=$2 OR to_char(start_date,'MM-DD')=$3) ORDER BY start_date`,
  [year - 1, priorName === period.name ? null : priorName, period.start.slice(5)]);
  if (rows.length !== 1) return null;
  const prior = normalize(rows[0]);
  const metrics = require('../routes/metrics');
  const stores = await metrics.scopeStores(query, auth, scope);
  const month = await metrics.totals(query, scope, stores, prior.start, prior.end);
  const index = week ? period.weeks.findIndex((w) => w.id === week.id) : -1;
  const priorWeek = index >= 0 ? prior.weeks[index] : null;
  return { period: { name: prior.name, start: prior.start, end: prior.end }, month,
    week: priorWeek ? { ...priorWeek, ...(await metrics.totals(query, scope, stores, priorWeek.start, priorWeek.end)) } : null };
}
module.exports = { reference };
