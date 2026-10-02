const { randomUUID } = require("node:crypto");
const pg = require("../db/pg");
const v = require("../utils/validation");
const { candidates } = require("./business");
const metrics = require('./metrics');
const contacts = require('./contacts');
function metricScope(auth, workspace) {
  if (workspace === 'manager' && auth.managerStores?.some((s) => s.store_id === auth.storeId))
    return { scope: 'store', scopeId: auth.storeId };
  return { scope: 'personal', scopeId: auth.employeeId };
}
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
      : (await candidates(pg.query, ctx.auth.employeeId, date)).filter((b) => !report || stored.some((e) => e.businessType === b.businessType && e.businessId === b.businessId));
  if (report?.status !== 'submitted') {
    const manual = stored.filter((e) => e.snapshot.auto === false);
    const byDate = new Map();
    for (const e of manual) {
      const sourceDate = e.snapshot.businessDate || date;
      if (!byDate.has(sourceDate)) byDate.set(sourceDate, await candidates(pg.query, ctx.auth.employeeId, sourceDate));
      const fresh = byDate.get(sourceDate).find((b) => b.businessId === e.businessId && b.businessType === e.businessType);
      if (!current.some((b) => b.businessId === e.businessId && b.businessType === e.businessType))
        current.push({ ...(fresh || e.snapshot), auto: false, unavailable: !fresh });
    }
  }
  const map = new Map(
    stored.map((e) => [e.businessType + ":" + e.businessId, e]),
  );
  ctx.result = {
    date,
    report: report || null,
    readOnly: report?.status === "submitted" && date !== v.today(),
    metrics: report?.status === 'submitted' ? report.metric_snapshot || null
      : await metrics.capture(pg.query, ctx.auth, { date, ...metricScope(ctx.auth, ctx.event.payload?.workspace) }),
    entries: current.map((b) => ({
      ...b,
      auto: map.get(b.businessType + ':' + b.businessId)?.snapshot.auto === false ? false : b.auto,
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
    const previous = new Map((old ? await entries(query, old.id) : []).map((e) => [e.businessType + ':' + e.businessId, e.snapshot]));
    let snapshots =
      old?.status === "submitted"
        ? (await entries(query, old.id)).map((e) => e.snapshot)
        : (await candidates(query, ctx.auth.employeeId, input.reportDate)).filter((b) => !old || previous.has(b.businessType + ':' + b.businessId) || input.entries.some((e) => e.businessType === b.businessType && e.businessId === b.businessId));
    const supplied = new Map(
      input.entries.map((e) => [e.businessType + ":" + e.businessId, e]),
    );
    for (const e of input.entries) {
      const key = e.businessType + ':' + e.businessId;
      if (e.businessDate !== input.reportDate && previous.get(key)?.businessDate !== e.businessDate)
        throw Error('INVALID_PARAMS: 只能补充同一日报日期的业务');
    }
    snapshots = snapshots.map((b) => {
      const key = b.businessType + ':' + b.businessId, prior = previous.get(key), inputEntry = supplied.get(key);
      return { ...b, auto: prior ? prior.auto !== false : inputEntry?.auto !== false };
    });
    // 自动条目保留，手动条目允许移除；新增条目逐个从可信业务查询生成快照。
    snapshots = snapshots.filter((b) => b.auto !== false || supplied.has(b.businessType + ':' + b.businessId));
    const known = new Set(snapshots.map((b) => b.businessType + ':' + b.businessId));
    const manualDates = [...new Set(input.entries.filter((e) => !known.has(e.businessType + ':' + e.businessId)).map((e) => e.businessDate))];
    const extra = new Map();
    for (const date of manualDates) {
      for (const b of await candidates(query, ctx.auth.employeeId, date)) extra.set(b.businessType + ':' + b.businessId, b);
    }
    for (const e of input.entries) {
      const key = e.businessType + ':' + e.businessId;
      if (known.has(key)) continue;
      const b = extra.get(key);
      if (!b || b.businessDate !== e.businessDate) throw Error('CONFLICT: 业务归属已变化，请重新加载；填写内容尚未保存');
      snapshots.push({ ...b, auto: false }); known.add(key);
    }
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
    const metricSnapshot = submit ? await metrics.capture(query, ctx.auth,
      { date: input.reportDate, ...metricScope(ctx.auth, ctx.event.payload?.workspace) }) : null;
    const guidance = await contacts.validate(query, ctx.auth, input.mentorEmployeeId, input.peerEmployeeId);
    if (metricSnapshot) metricSnapshot.guidance = guidance;
    const [report] = await query(
      `INSERT INTO daily_reports(id,employee_id,report_date,store_id,employee_name,store_name,status,version,action,growth,plan,submitted_at,period_snapshot,metric_snapshot,mentor_employee_id,peer_employee_id)
      VALUES($1,$2,$3,$4,$5,$6,$7,1,$8,$9,$10,CASE WHEN $7='submitted' THEN NOW() ELSE NULL END,$11::jsonb,$12::jsonb,$13,$14)
      ON CONFLICT(employee_id,report_date) DO UPDATE SET status=EXCLUDED.status,version=daily_reports.version+1,
      action=EXCLUDED.action,growth=EXCLUDED.growth,plan=EXCLUDED.plan,
      store_id=CASE WHEN daily_reports.status='submitted' THEN daily_reports.store_id ELSE EXCLUDED.store_id END,
      store_name=CASE WHEN daily_reports.status='submitted' THEN daily_reports.store_name ELSE EXCLUDED.store_name END,
      employee_name=CASE WHEN daily_reports.status='submitted' THEN daily_reports.employee_name ELSE EXCLUDED.employee_name END,
      period_snapshot=EXCLUDED.period_snapshot,metric_snapshot=EXCLUDED.metric_snapshot,
      mentor_employee_id=EXCLUDED.mentor_employee_id,peer_employee_id=EXCLUDED.peer_employee_id,
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
        JSON.stringify(metricSnapshot?.period || null),
        JSON.stringify(metricSnapshot),
        input.mentorEmployeeId || null,
        input.peerEmployeeId || null,
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
  const payload = ctx.event.payload || {};
  const employeeId = payload.employeeId ? v.text(payload.employeeId, 30) : ctx.auth.employeeId;
  const own = employeeId === ctx.auth.employeeId;
  const { reportStores } = require('../utils/report-scope');
  const storeIds = reportStores(ctx.auth).map((s) => s.store_id);
  const [employee] = await pg.query(`SELECT employee_id,name,store_id FROM staff_wechat_users
    WHERE employee_id=$1 AND ($2::boolean OR store_id=ANY($3::text[]))`, [employeeId, own, storeIds]);
  if (!employee) throw Error('NOT_FOUND: 员工不存在或无权查看');
  const resolved = payload.periodId ? await require('./period').resolve(pg.query, payload) : null;
  if (payload.periodId && !resolved.period) throw Error('NOT_FOUND: 经营周期不存在');
  const period = resolved?.period;
  const end = period ? (period.end < v.today() ? period.end : v.today()) : v.today();
  const reports = await pg.query(`SELECT id,report_date,status,updated_at FROM daily_reports
    WHERE employee_id=$1 AND ($2::boolean OR (status='submitted' AND store_id=ANY($3::text[])))
      AND ($4::date IS NULL OR report_date BETWEEN $4::date AND $5::date)
    ORDER BY report_date DESC LIMIT 366`, [employeeId, own, storeIds, period?.start || null, end]);
  let summary = null;
  if (period) {
    const people = await require('../utils/submission-range').people(pg.query, [employee.store_id], { start: period.start, end });
    summary = require('../utils/submission-range').summary(people.filter((e) => e.employee_id === employeeId));
  }
  ctx.result = { employee, own, period: period || null, reports, summary };
}
async function previous(ctx) {
  const date = v.date(ctx.event.payload?.date);
  const [report] = await pg.query(
    `SELECT report_date,action,growth,plan FROM daily_reports
     WHERE employee_id=$1 AND report_date<$2 AND status='submitted'
     ORDER BY report_date DESC LIMIT 1`,
    [ctx.auth.employeeId, date],
  );
  ctx.result = { report: report || null };
}
module.exports = {
  read,
  history,
  previous,
  save: (ctx) => write(ctx, false),
  submit: (ctx) => write(ctx, true),
};
