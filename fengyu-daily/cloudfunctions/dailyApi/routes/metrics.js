const pg = require('../db/pg');
const { resolve } = require('./period');
const target = require('./target');
const { targetScope } = require('../utils/target-scope');
const { excludeDepositRefundSql } = require('../utils/consume-filter');

async function scopeStores(query, auth, scope) {
  if (scope.scope === 'personal') return null;
  if (scope.scope === 'store') return [scope.scopeId];
  const rows = await query(`WITH RECURSIVE subtree AS (
    SELECT id FROM org_nodes WHERE id=$1
    UNION ALL SELECT n.id FROM org_nodes n JOIN subtree s ON n.parent_id=s.id
  ) SELECT store_id FROM stores WHERE org_node_id IN (SELECT id FROM subtree)
    AND store_id=ANY($2::text[])`, [scope.scopeId, auth.scopedStores.map((s) => s.store_id)]);
  return rows.map((s) => s.store_id);
}

async function totals(query, scope, stores, start, end) {
  if (start > end) return { sales: 0, consumption: 0 };
  const personal = scope.scope === 'personal';
  const sales = personal
    ? `SELECT ROUND(COALESCE(SUM(ROUND(a.allocated_amount::numeric *
        COALESCE(i.performance_amount::numeric / NULLIF(r.amount::numeric,0),0),2)),0)*100)::bigint AS amount
       FROM sale_payment_item_allocations a JOIN sale_payment_item_receipts r ON r.id=a.sale_payment_item_receipt_id
       JOIN sale_reportable_item_events i ON i.receipt_id=r.id
       JOIN sale_reportable_payment_events p ON p.sale_payment_id=r.sale_payment_id
       WHERE NOT a.is_void AND a.employee_id=$1 AND p.status='已支付'
       AND p.sale_order_type IN ('销售单','转换单') AND p.performance_date BETWEEN $2 AND $3`
    : `SELECT ROUND(COALESCE(SUM(performance_amount),0)*100)::bigint AS amount
       FROM sale_reportable_payment_events WHERE store_id=ANY($1::text[]) AND status='已支付'
       AND sale_order_type IN ('销售单','转换单') AND performance_date BETWEEN $2 AND $3`;
  const consumption = personal
    ? `SELECT ROUND(COALESCE(SUM(i.unit_real_price::numeric*i.session_used*c.allocation_ratio),0)*100)::bigint AS amount
       FROM service_commissions c JOIN service_items i ON i.service_item_id=c.service_item_id
       JOIN service_orders so ON so.service_order_id=i.service_order_id
       WHERE NOT c.is_void AND c.employee_id=$1 AND so.status='已完成'
       AND so.service_date BETWEEN $2 AND $3 AND ${excludeDepositRefundSql('so')}`
    : `SELECT ROUND(COALESCE(SUM(i.unit_real_price::numeric*i.session_used),0)*100)::bigint AS amount
       FROM service_items i JOIN service_orders so ON so.service_order_id=i.service_order_id
       WHERE so.store_id=ANY($1::text[]) AND so.status='已完成' AND so.service_date BETWEEN $2 AND $3
       AND ${excludeDepositRefundSql('so')}`;
  const [saleRows, consumeRows] = await Promise.all([
    query(sales, [personal ? scope.scopeId : stores, start, end]),
    query(consumption, [personal ? scope.scopeId : stores, start, end]),
  ]);
  const result = { sales: saleRows[0].amount, consumption: consumeRows[0].amount };
  if (!Object.values(result).every(Number.isSafeInteger)) throw Error('INVALID_STATE: 经营金额超出可计算范围');
  return result;
}

async function capture(query, auth, payload = {}) {
  const scope = await targetScope(auth, payload, query);
  const { date, period, week } = await resolve(query, payload);
  const stores = await scopeStores(query, auth, scope);
  const day = await totals(query, scope, stores, date, date);
  if (!period) return { date, ...scope, day, period: null, week: null, month: null };
  const saved = target.expand(await target.load(query, period.id, scope.scope, scope.scopeId), period);
  const cutoff = date < period.end ? date : period.end;
  const monthDone = await totals(query, scope, stores, period.start, cutoff);
  const active = week || [...period.weeks].reverse().find((w) => w.start <= cutoff) || null;
  const weekDone = active ? await totals(query, scope, stores, active.start, cutoff < active.end ? cutoff : active.end) : null;
  const combine = (done, values) => ({ sales: { done: done.sales, target: values?.sales ?? null },
    consumption: { done: done.consumption, target: values?.consumption ?? null } });
  return { date, ...scope, day, period, week: active && weekDone ? { ...active, ...combine(weekDone, saved?.weeks[active.id]) } : null,
    month: { ...combine(monthDone, saved), start: period.start, end: period.end }, savedAt: new Date().toISOString() };
}

async function read(ctx) { ctx.result = await capture(pg.query, ctx.auth, ctx.event.payload); }
module.exports = { read, capture, totals, scopeStores };
