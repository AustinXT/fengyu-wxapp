const { randomUUID } = require("node:crypto");
const pg = require("../db/pg");
const v = require("../utils/validation");
const { candidates } = require("./business");
async function entries(query, id) {
  return query(
    `SELECT business_type AS "businessType",business_id AS "businessId",snapshot,feedback,follow_up AS "followUp"
    FROM daily_report_entries WHERE report_id=$1 ORDER BY business_type,business_id`,
    [id],
  );
}
async function read(ctx) {
  const date = v.date(ctx.event.payload?.date);
  const [report] = await pg.query(
    "SELECT * FROM daily_reports WHERE employee_id=$1 AND report_date=$2",
    [ctx.auth.employeeId, date],
  );
  const stored = report ? await entries(pg.query, report.id) : [];
  const current =
    report?.status === "submitted"
      ? stored.map((e) => e.snapshot)
      : await candidates(pg.query, ctx.auth.employeeId, date);
  const map = new Map(
    stored.map((e) => [e.businessType + ":" + e.businessId, e]),
  );
  ctx.result = {
    date,
    report: report || null,
    readOnly: report?.status === "submitted" && date !== v.today(),
    entries: current.map((b) => ({
      ...b,
      feedback: map.get(b.businessType + ":" + b.businessId)?.feedback || "",
      followUp: map.get(b.businessType + ":" + b.businessId)?.followUp || "",
    })),
  };
}
async function write(ctx, submit) {
  const input = v.body(ctx.event.payload);
  if (!ctx.auth.storeId)
    throw new Error("INVALID_STATE: 员工尚未分配门店，请联系管理员");
  ctx.result = await pg.transaction(async (client) => {
    const query = async (sql, args) => (await client.query(sql, args)).rows;
    // 同员工/日期串行化；包括尚未创建首份草稿的并发请求。
    await query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [
      ctx.auth.employeeId + ":" + input.reportDate,
    ]);
    const [old] = await query(
      "SELECT * FROM daily_reports WHERE employee_id=$1 AND report_date=$2 FOR UPDATE",
      [ctx.auth.employeeId, input.reportDate],
    );
    if ((old?.version || 0) !== input.version)
      throw new Error("CONFLICT: 日报已更新，请重新加载后再编辑");
    if (
      old?.status === "submitted" &&
      (!submit || input.reportDate !== v.today())
    )
      throw new Error(
        "INVALID_STATE: 已提交的历史日报不能修改；今日日报可再次提交",
      );
    const snapshots =
      old?.status === "submitted"
        ? (await entries(query, old.id)).map((e) => e.snapshot)
        : await candidates(query, ctx.auth.employeeId, input.reportDate);
    const supplied = new Map(
      input.entries.map((e) => [e.businessType + ":" + e.businessId, e]),
    );
    const allowed = new Set(
      snapshots.map((b) => b.businessType + ":" + b.businessId),
    );
    if (
      input.entries.some(
        (e) => !allowed.has(e.businessType + ":" + e.businessId),
      )
    )
      throw new Error("CONFLICT: 业务归属已变化，请重新加载；填写内容尚未保存");
    const id = old?.id || randomUUID();
    const [report] = await query(
      `INSERT INTO daily_reports(id,employee_id,report_date,store_id,employee_name,store_name,status,version,action,growth,plan,submitted_at)
      VALUES($1,$2,$3,$4,$5,$6,$7,1,$8,$9,$10,CASE WHEN $7='submitted' THEN NOW() ELSE NULL END)
      ON CONFLICT(employee_id,report_date) DO UPDATE SET status=EXCLUDED.status,version=daily_reports.version+1,
      action=EXCLUDED.action,growth=EXCLUDED.growth,plan=EXCLUDED.plan,
      store_id=CASE WHEN daily_reports.status='submitted' THEN daily_reports.store_id ELSE EXCLUDED.store_id END,
      store_name=CASE WHEN daily_reports.status='submitted' THEN daily_reports.store_name ELSE EXCLUDED.store_name END,
      employee_name=CASE WHEN daily_reports.status='submitted' THEN daily_reports.employee_name ELSE EXCLUDED.employee_name END,
      submitted_at=COALESCE(daily_reports.submitted_at,EXCLUDED.submitted_at),updated_at=NOW() RETURNING *`,
      [
        id,
        ctx.auth.employeeId,
        input.reportDate,
        ctx.auth.storeId,
        ctx.auth.name,
        ctx.auth.storeName,
        submit ? "submitted" : "draft",
        input.action,
        input.growth,
        input.plan,
      ],
    );
    await query("DELETE FROM daily_report_entries WHERE report_id=$1", [id]);
    for (const b of snapshots) {
      const e = supplied.get(b.businessType + ":" + b.businessId);
      await query(
        `INSERT INTO daily_report_entries(id,report_id,business_type,business_id,snapshot,feedback,follow_up) VALUES($1,$2,$3,$4,$5::jsonb,$6,$7)`,
        [
          randomUUID(),
          id,
          b.businessType,
          b.businessId,
          JSON.stringify(b),
          e?.feedback || "",
          e?.followUp || "",
        ],
      );
    }
    return { report };
  });
}
async function history(ctx) {
  ctx.result = {
    reports: await pg.query(
      `SELECT id,report_date,status,updated_at FROM daily_reports WHERE employee_id=$1 ORDER BY report_date DESC LIMIT 60`,
      [ctx.auth.employeeId],
    ),
  };
}
module.exports = {
  read,
  history,
  save: (ctx) => write(ctx, false),
  submit: (ctx) => write(ctx, true),
};
