const v = require('./validation');
const { resolve } = require('../routes/period');
async function range(query, payload = {}, auth = null, regionId = null) {
  const date = v.date(payload.date), kind = payload.period || 'today';
  if (!['today', 'week', 'month'].includes(kind)) throw Error('INVALID_PARAMS: 无效日报查看周期');
  if (kind === 'today') return { date, start: date, end: date, kind, label: '今日' };
  const { period, week } = await resolve(query, payload, auth, regionId);
  if (!period) throw Error('INVALID_STATE: 尚未配置对应经营周期');
  if (kind === 'week' && !week) throw Error('INVALID_STATE: 该日期不在所选经营月，请选择本经营月');
  const start = kind === 'week' ? week.start : period.start;
  const last = kind === 'week' ? week.end : period.end;
  return { date, start, end: last < date ? last : date, kind, periodId: period.id,
    label: kind === 'week' ? `${period.name} · ${week.name}` : period.name };
}
async function people(query, storeIds, range) {
  return query(`SELECT u.employee_id,u.name,u.store_id,s.store_name,u.position_name,
    EXISTS(SELECT 1 FROM permission_roles pr JOIN permission_role_definitions rd ON rd.role_key=pr.role
      WHERE pr.employee_id=u.employee_id AND rd.is_store_manager) AS is_store_manager,
    GREATEST(0,LEAST($3::date,COALESCE(u.resigned_at-1,$3::date))-
      GREATEST($2::date,COALESCE(u.hired_at,u.created_at::date))+1)::int AS due,
    count(r.id)::int AS submitted, max(r.id) AS report_id
    FROM staff_wechat_users u JOIN stores s ON s.store_id=u.store_id
    LEFT JOIN daily_reports r ON r.employee_id=u.employee_id AND r.store_id=u.store_id AND r.status='submitted'
      AND r.report_date BETWEEN GREATEST($2::date,COALESCE(u.hired_at,u.created_at::date))
      AND LEAST($3::date,COALESCE(u.resigned_at-1,$3::date))
    WHERE u.store_id=ANY($1::text[]) AND COALESCE(u.hired_at,u.created_at::date)<=$3::date
      AND (u.resigned_at IS NULL OR u.resigned_at>$2::date) AND (NOT u.is_resigned OR u.resigned_at IS NOT NULL)
    GROUP BY u.employee_id,s.store_name ORDER BY s.store_name,u.name,u.employee_id`, [storeIds, range.start, range.end]);
}
function summary(employees) {
  const due = employees.reduce((sum, e) => sum + e.due, 0), submitted = employees.reduce((sum, e) => sum + e.submitted, 0);
  return { due, submitted, missing: Math.max(0, due - submitted), rate: due ? Math.round(submitted / due * 100) : 0 };
}
module.exports = { range, people, summary };
