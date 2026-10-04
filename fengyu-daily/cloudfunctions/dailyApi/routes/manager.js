const pg = require("../db/pg");
const v = require("../utils/validation");
const { reportStores } = require('../utils/report-scope');
const submissions = require('../utils/submission-range');
const metrics = require('./metrics');
function assertStore(ctx, storeId) {
  if (
    typeof storeId !== "string" ||
    !reportStores(ctx.auth).some((s) => s.store_id === storeId)
  )
    throw new Error("PERMISSION_DENIED: 无权查看该门店日报");
}
async function list(ctx) {
  const storeId = ctx.event.payload?.storeId;
  assertStore(ctx, storeId);
  const range = await submissions.range(pg.query, ctx.event.payload), date = range.date;
  // 草稿内容、版本、是否存在均不向店长暴露。
  const reports = await pg.query(
    `SELECT r.id,r.employee_id,r.employee_name,r.report_date,r.submitted_at
    FROM daily_reports r WHERE r.store_id=$1 AND r.report_date BETWEEN $2 AND $3 AND r.status='submitted' ORDER BY r.report_date DESC,r.submitted_at DESC`,
    [storeId, range.start, range.end],
  );
  const employees = await submissions.people(pg.query, [storeId], range);
  ctx.result = {
    date,
    range,
    reports,
    employees,
    summary: submissions.summary(employees),
    unsubmitted: employees.filter((e) => e.submitted < e.due),
  };
}
async function detail(ctx) {
  const payload = ctx.event.payload || {};
  const id = payload.id;
  if (id && (typeof id !== 'string' || id.length > 100)) throw Error('INVALID_PARAMS: 无效日报编号');
  const date = id ? null : v.date(payload.date);
  const [report] = await pg.query(
    `SELECT * FROM daily_reports WHERE status='submitted'
      AND (($1::text IS NOT NULL AND id=$1) OR ($1::text IS NULL AND employee_id=$3 AND report_date=$4::date))
      AND (employee_id=$3 OR store_id=ANY($2::text[]))`,
    [id || null, reportStores(ctx.auth).map((s) => s.store_id), ctx.auth.employeeId, date],
  );
  if (!report) throw new Error("NOT_FOUND: 日报不存在或无权查看");
  const own = report.employee_id === ctx.auth.employeeId;
  const entries = await pg.query(
    `SELECT snapshot,feedback,follow_up AS "followUp" FROM daily_report_entries WHERE report_id=$1 ORDER BY business_type,business_id`,
    [report.id],
  );
  const metricSnapshot = metrics.reportSnapshotForViewer(
    report.metric_snapshot, ctx.auth, report, payload.workspace,
  );
  ctx.result = {
    report: { ...report, metric_snapshot: metricSnapshot },
    own, canEdit: own && report.report_date === v.today(),
    entries: entries.map((e) => ({
      ...e.snapshot,
      feedback: e.feedback,
      followUp: e.followUp,
    })),
  };
}
module.exports = { list, detail };
