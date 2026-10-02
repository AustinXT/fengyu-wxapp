const pg = require("../db/pg");
const v = require("../utils/validation");
const { reportStores } = require('../utils/report-scope');
function assertStore(ctx, storeId) {
  if (
    typeof storeId !== "string" ||
    !reportStores(ctx.auth).some((s) => s.store_id === storeId)
  )
    throw new Error("PERMISSION_DENIED: 无权查看该门店日报");
}
async function list(ctx) {
  const date = v.date(ctx.event.payload?.date),
    storeId = ctx.event.payload?.storeId;
  assertStore(ctx, storeId);
  // 草稿内容、版本、是否存在均不向店长暴露。
  const reports = await pg.query(
    `SELECT r.id,r.employee_id,r.employee_name,r.submitted_at
    FROM daily_reports r WHERE r.store_id=$1 AND r.report_date=$2 AND r.status='submitted' ORDER BY r.submitted_at DESC`,
    [storeId, date],
  );
  const employees = await pg.query(
    `SELECT u.employee_id,u.name FROM staff_wechat_users u WHERE u.store_id=$1 AND NOT u.is_resigned ORDER BY u.name`,
    [storeId],
  );
  ctx.result = {
    date,
    reports,
    unsubmitted: employees.filter(
      (e) => !reports.some((r) => r.employee_id === e.employee_id),
    ),
  };
}
async function detail(ctx) {
  const id = ctx.event.payload?.id;
  if (typeof id !== "string" || id.length > 100)
    throw new Error("INVALID_PARAMS: 缺少日报编号");
  const [report] = await pg.query(
    `SELECT * FROM daily_reports WHERE id=$1 AND status='submitted' AND store_id=ANY($2::text[])`,
    [id, reportStores(ctx.auth).map((s) => s.store_id)],
  );
  if (!report) throw new Error("NOT_FOUND: 日报不存在或无权查看");
  const entries = await pg.query(
    `SELECT snapshot,feedback,follow_up AS "followUp" FROM daily_report_entries WHERE report_id=$1 ORDER BY business_type,business_id`,
    [id],
  );
  ctx.result = {
    report,
    entries: entries.map((e) => ({
      ...e.snapshot,
      feedback: e.feedback,
      followUp: e.followUp,
    })),
  };
}
module.exports = { list, detail };
