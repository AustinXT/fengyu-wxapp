const pg = require('../db/pg');
const { resolve } = require('./period');
const target = require('./target');
const { rankRows } = require('../utils/pk-rules');
const { reportStores } = require('../utils/report-scope');
const { excludeDepositRefundSql } = require('../utils/consume-filter');
function stores(auth) {
  return [...new Set([auth.storeId, ...reportStores(auth).map((s) => s.store_id)].filter(Boolean))];
}
async function classes(ctx) {
  const { period } = await resolve(pg.query, ctx.event.payload);
  const rows = period ? await pg.query(`SELECT c.id,c.name,count(u.employee_id)::int AS members,count(DISTINCT ps.store_id)::int AS stores
    FROM daily_pk_classes c JOIN daily_pk_stores ps ON ps.class_id=c.id AND ps.period_id=c.period_id
    LEFT JOIN staff_wechat_users u ON u.store_id=ps.store_id AND NOT u.is_resigned
    WHERE c.period_id=$1 AND ps.store_id=ANY($2::text[]) GROUP BY c.id,c.name ORDER BY c.name`,
  [period.id, stores(ctx.auth)]) : [];
  ctx.result = { period, classes: rows, scopeLabel: '人数及排名仅统计您有权限查看的门店' };
}
async function read(ctx) {
  const { date, period, week } = await resolve(pg.query, ctx.event.payload);
  if (!period) throw Error('NOT_FOUND: 经营周期不存在');
  const active = week || [...period.weeks].reverse().find((w) => w.start <= date);
  if (!active) throw Error('INVALID_STATE: 经营月尚未开始');
  const classId = ctx.event.payload?.classId;
  if (typeof classId !== 'string' || classId.length > 100) throw Error('INVALID_PARAMS: 缺少PK班级');
  const allowedStores = stores(ctx.auth);
  const [klass] = await pg.query(`SELECT c.id,c.name FROM daily_pk_classes c WHERE c.id=$1 AND c.period_id=$2
    AND EXISTS(SELECT 1 FROM daily_pk_stores ps WHERE ps.class_id=c.id AND ps.period_id=c.period_id AND ps.store_id=ANY($3::text[]))`,
  [classId, period.id, allowedStores]);
  if (!klass) throw Error('NOT_FOUND: 班级不存在或无权查看');
  const people = await pg.query(`WITH RECURSIVE lineage AS (
    SELECT s.store_id,n.id,n.name,n.type,n.parent_id FROM stores s JOIN org_nodes n ON n.id=s.org_node_id
    WHERE s.store_id=ANY($3::text[])
    UNION ALL SELECT l.store_id,n.id,n.name,n.type,n.parent_id FROM lineage l JOIN org_nodes n ON n.id=l.parent_id
    ) SELECT u.employee_id,u.name,s.store_name,(SELECT name FROM lineage l WHERE l.store_id=s.store_id AND l.type='市场' LIMIT 1) AS area,ps.legion,ps.group_name,ps.mentor_name,
    t.sales,t.consumption,t.weeks,t.month_confirmed
    FROM daily_pk_stores ps JOIN stores s ON s.store_id=ps.store_id
    JOIN staff_wechat_users u ON u.store_id=s.store_id AND NOT u.is_resigned
    LEFT JOIN daily_operating_targets t ON t.period_id=ps.period_id AND t.scope='personal' AND t.scope_id=u.employee_id
    WHERE ps.period_id=$1 AND ps.class_id=$2 AND ps.store_id=ANY($3::text[]) ORDER BY s.store_name,u.name,u.employee_id`,
  [period.id, classId, allowedStores]);
  const ids = people.map((e) => e.employee_id), cutoff = date < period.end ? date : period.end;
  const [sales, consumption] = await Promise.all([
    pg.query(`WITH amounts AS (SELECT a.employee_id,p.performance_date AS date,
      ROUND(a.allocated_amount::numeric*COALESCE(i.performance_amount::numeric/NULLIF(r.amount::numeric,0),0),2)*100 AS amount
      FROM sale_payment_item_allocations a JOIN sale_payment_item_receipts r ON r.id=a.sale_payment_item_receipt_id
      JOIN sale_reportable_item_events i ON i.receipt_id=r.id JOIN sale_reportable_payment_events p ON p.sale_payment_id=r.sale_payment_id
      WHERE NOT a.is_void AND a.employee_id=ANY($1::text[]) AND p.status='已支付' AND p.sale_order_type IN ('销售单','转换单')
      AND p.performance_date BETWEEN $2 AND $3)
      SELECT employee_id,SUM(amount)::bigint AS month_done,COALESCE(SUM(amount) FILTER(WHERE date BETWEEN $4 AND $5),0)::bigint AS week_done
      FROM amounts GROUP BY employee_id`, [ids, period.start, cutoff, active.start, active.end < cutoff ? active.end : cutoff]),
    pg.query(`SELECT c.employee_id,ROUND(SUM(i.unit_real_price::numeric*i.session_used*c.allocation_ratio)*100)::bigint AS month_done,
      ROUND(COALESCE(SUM(i.unit_real_price::numeric*i.session_used*c.allocation_ratio) FILTER(WHERE so.service_date BETWEEN $4 AND $5),0)*100)::bigint AS week_done
      FROM service_commissions c JOIN service_items i ON i.service_item_id=c.service_item_id JOIN service_orders so ON so.service_order_id=i.service_order_id
      WHERE NOT c.is_void AND c.employee_id=ANY($1::text[]) AND so.status='已完成' AND so.service_date BETWEEN $2 AND $3
      AND ${excludeDepositRefundSql('so')} GROUP BY c.employee_id`, [ids, period.start, cutoff, active.start, active.end < cutoff ? active.end : cutoff]),
  ]);
  const maps = { sales: new Map(sales.map((r) => [r.employee_id, r])), consumption: new Map(consumption.map((r) => [r.employee_id, r])) };
  const rows = people.map((p) => {
    const configured = p.month_confirmed ? target.expand(p, period) : null;
    const row = { employeeId: p.employee_id, name: p.name, area: p.area || p.store_name, legion: p.legion, group: p.group_name, mentor: p.mentor_name };
    for (const metric of ['sales', 'consumption']) {
      const amounts = period.weeks.filter((w) => w.start <= cutoff).map((w) => configured?.weeks[w.id]?.[metric] ?? null);
      const monthTarget = amounts.every((n) => n !== null) ? amounts.reduce((sum, n) => sum + n, 0) : null;
      const done = maps[metric].get(p.employee_id);
      row[metric] = { weekTarget: configured?.weeks[active.id]?.[metric] ?? null, weekDone: done?.week_done || 0,
        monthTarget, monthDone: done?.month_done || 0 };
      if (!Object.values(row[metric]).every((n) => n === null || Number.isSafeInteger(n))) throw Error('INVALID_STATE: PK金额超出可计算范围');
    }
    return row;
  });
  const metric = ctx.event.payload?.metric || 'sales';
  ctx.result = { period, week: active, class: klass, metric, rows: rankRows(rows, metric), scopeLabel: '排名仅统计授权门店' };
}
module.exports = { classes, read };
