const pg = require('../db/pg');
const { resolve } = require('./period');
const target = require('./target');
const { targetScope } = require('../utils/target-scope');
const { excludeDepositRefundSql } = require('../utils/consume-filter');
const { series, marketNewCustomers } = require('../utils/operating-series');
const jitDisabledQuery = require('../utils/query-with-jit-disabled');
const { performance } = require('node:perf_hooks');

const actualKeys = ['sales', 'consumption', 'visits', 'newCustomers', 'projects'];
const emptyActual = () => Object.fromEntries(actualKeys.map((key) => [key, 0]));
function addEventTotals(total, row) {
  for (const key of actualKeys) total[key] += Number(row[key] || 0);
  return total;
}
function sumEvents(events, scope, ids, start, end) {
  const allowed = new Set(Array.isArray(ids) ? ids : [ids]);
  return events.filter((row) => row.scope === scope && allowed.has(row.id) &&
    String(row.date) >= start && String(row.date) <= end)
    .reduce(addEventTotals, emptyActual());
}
function sumMarketNewCustomers(rows, start, end) {
  return new Set(rows.filter((row) => String(row.date) >= start && String(row.date) <= end)
    .map((row) => row.client_user_id)).size;
}

// Submit-time snapshot: capture personal, store and the report store's market
// through the report date. Store/market counts use scope-level events so
// shared customers are not double-counted by summing employee rows.
async function captureReportSnapshot(query, auth, payload = {}) {
  const startedAt = performance.now();
  const timings = {};
  const measure = async (name, operation) => {
    const started = performance.now();
    try { return await operation(); }
    finally { timings[name] = Math.round(performance.now() - started); }
  };
  const { date, period, week } = await measure('periodResolve', () => resolve(query, payload));
  if (!auth.storeId) throw Error('INVALID_STATE: 员工尚未分配门店');
  const start = period?.start || date;
  const requestedWorkspace = payload.workspace;
  const preferredScope = requestedWorkspace === 'manager' &&
    auth.managerStores?.some((store) => store.store_id === auth.storeId)
    ? 'store' : 'personal';
  const includeAllScopes = payload.includeAllScopes !== false;
  const [marketRow] = includeAllScopes ? await measure('marketLookup', () => query(
    "WITH RECURSIVE ancestors AS (SELECT n.id,n.parent_id,n.type FROM stores s JOIN org_nodes n ON n.id=s.org_node_id WHERE s.store_id=$1 UNION ALL SELECT n.id,n.parent_id,n.type FROM org_nodes n JOIN ancestors a ON a.parent_id=n.id) SELECT id FROM ancestors WHERE type='市场' ORDER BY id LIMIT 1",
    [auth.storeId],
  )) : [];
  const marketId = marketRow?.id || null;
  const marketStores = includeAllScopes && marketId ? await measure('marketStores', () => query(
    'WITH RECURSIVE descendants AS (SELECT id FROM org_nodes WHERE id=$1 UNION ALL SELECT n.id FROM org_nodes n JOIN descendants d ON n.parent_id=d.id) SELECT store_id FROM stores WHERE org_node_id IN (SELECT id FROM descendants) ORDER BY store_id',
    [marketId],
  )) : [];
  const marketStoreIds = [...new Set([auth.storeId, ...marketStores.map((row) => row.store_id)])];
  const employees = includeAllScopes ? await measure('employees', () => query(
    'SELECT employee_id FROM staff_wechat_users WHERE store_id=ANY($1::text[]) AND NOT is_resigned',
    [marketStoreIds],
  )) : [];
  const employeeIds = [...new Set([auth.employeeId, ...employees.map((row) => row.employee_id)])];
  const seriesQuery = query.withJitDisabled ||
    (query === pg.query ? jitDisabledQuery.query : query);
  const [events, firstVisits] = await Promise.all([
    measure('operatingSeries', () => series(seriesQuery, { storeIds: marketStoreIds, employeeIds, start, end: date })),
    includeAllScopes && marketId
      ? measure('marketNewCustomers', () => marketNewCustomers(query, marketStoreIds, start, date))
      : Promise.resolve([]),
  ]);
  const ranges = {
    day: [date, date],
    week: week ? [week.start, date] : null,
    month: period ? [period.start, date] : null,
  };
  const makeScope = (scope, scopeId, ids = scopeId) => {
    const values = {};
    for (const [name, range] of Object.entries(ranges)) {
      if (!range) { values[name] = null; continue; }
      const totals = scope === 'market'
        ? sumEvents(events, 'store', ids, range[0], range[1])
        : sumEvents(events, scope, scopeId, range[0], range[1]);
      if (scope === 'market') totals.newCustomers = sumMarketNewCustomers(firstVisits, range[0], range[1]);
      if (!actualKeys.every((key) => Number.isSafeInteger(totals[key])))
        throw Error('INVALID_STATE: 实际经营统计超出可计算范围');
      values[name] = totals;
    }
    return { scope, scopeId, ...values };
  };
  const scopes = includeAllScopes ? {
    personal: makeScope('personal', auth.employeeId),
    store: makeScope('store', auth.storeId),
  } : { [preferredScope]: makeScope(preferredScope, preferredScope === 'store' ? auth.storeId : auth.employeeId) };
  if (includeAllScopes && marketId) scopes.market = makeScope('market', marketId, marketStoreIds);
  const preferred = scopes[preferredScope];
  const result = {
    ...preferred,
    date,
    scopes,
    actuals: { day: preferred.day, week: preferred.week, month: preferred.month },
    period: period ? { id: period.id, name: period.name, start: period.start, end: period.end } : null,
    week: week ? { id: week.id, name: week.name, start: week.start, end: week.end } : null,
    savedAt: new Date().toISOString(),
  };
  console.log('report.metrics timing', { ...timings, total: Math.round(performance.now() - startedAt) });
  return result;
}

function selectReportSnapshot(snapshot, scope) {
  if (!snapshot || !snapshot.scopes) return snapshot || null;
  const selected = snapshot.scopes[scope];
  if (!selected) return null;
  return {
    ...snapshot,
    scope: selected.scope,
    scopeId: selected.scopeId,
    day: selected.day,
    month: selected.month,
    actuals: { day: selected.day, week: selected.week, month: selected.month },
    scopes: undefined,
  };
}

function reportSnapshotForViewer(snapshot, auth, report, workspace) {
  if (!snapshot) return null;
  const selectedWorkspace = workspace ||
    (auth.availableWorkspaces?.includes('management') ? 'management' :
      auth.managerStores?.some((store) => store.store_id === report.store_id) ? 'manager' : 'employee');
  let allowedScope = null;
  if (selectedWorkspace === 'employee' && report.employee_id === auth.employeeId) allowedScope = 'personal';
  if (selectedWorkspace === 'manager' &&
      auth.managerStores?.some((store) => store.store_id === report.store_id)) allowedScope = 'store';
  if (selectedWorkspace === 'management' && auth.availableWorkspaces?.includes('management')) {
    const marketId = snapshot.scopes?.market?.scopeId;
    const allowed = (auth.roleBindings || []).some((role) =>
      role.scopeType === '总部' && role.actions?.includes('data_center:dashboard') ||
      role.scopeType === '市场' && role.scopeId === marketId && role.actions?.includes('data_center:dashboard'));
    if (allowed) allowedScope = 'market';
  }
  if (!allowedScope) return null;
  if (!snapshot.scopes) return snapshot.scope === allowedScope ? snapshot : null;
  return selectReportSnapshot(snapshot, allowedScope);
}

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
module.exports = { read, capture, totals, scopeStores, captureReportSnapshot, selectReportSnapshot, reportSnapshotForViewer, sumEvents, sumMarketNewCustomers };
