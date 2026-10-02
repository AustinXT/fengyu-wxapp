const pg = require("../db/pg");
const v = require("../utils/validation");
const { requireManagement } = require("../utils/report-scope");
async function read(ctx) {
  requireManagement(ctx.auth);
  const date = v.date(ctx.event.payload?.date);
  const storeIds = ctx.auth.scopedStores.map((s) => s.store_id);
  const [nodes, employees] = await Promise.all([
    pg.query(
      "SELECT id,name,type,parent_id FROM org_nodes WHERE id=ANY($1::text[]) ORDER BY sort_order,name",
      [ctx.auth.scopeOrgNodeIds],
    ),
    pg.query(
      `SELECT u.employee_id,u.name,u.store_id,s.store_name,r.id AS report_id
      FROM staff_wechat_users u JOIN stores s ON s.store_id=u.store_id
      LEFT JOIN daily_reports r ON r.employee_id=u.employee_id AND r.store_id=u.store_id AND r.report_date=$2 AND r.status='submitted'
      WHERE u.store_id=ANY($1::text[]) AND NOT u.is_resigned ORDER BY s.store_name,u.name`,
      [storeIds, date],
    ),
  ]);
  const stores = ctx.auth.scopedStores.map((s) => {
    const people = employees.filter((e) => e.store_id === s.store_id);
    const submitted = people.filter((e) => e.report_id).length;
    return {
      ...s,
      due: people.length,
      submitted,
      missing: people.length - submitted,
      rate: people.length ? Math.round((submitted / people.length) * 100) : 0,
    };
  });
  const submitted = employees.filter((e) => e.report_id).length;
  ctx.result = {
    date,
    nodes,
    stores,
    employees,
    summary: {
      due: employees.length,
      submitted,
      missing: employees.length - submitted,
      rate: employees.length
        ? Math.round((submitted / employees.length) * 100)
        : 0,
    },
  };
}
module.exports = { read };
