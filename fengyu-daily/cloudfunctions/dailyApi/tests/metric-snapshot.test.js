const test = require('node:test');
const assert = require('node:assert/strict');
const metrics = require('../routes/metrics');

const period = {
  id: 'p1',
  name: '202610',
  start_date: '2026-09-26',
  end_date: '2026-10-25',
  version: 1,
  weeks: [
    { id: 'w1', name: '第1周', start: '2026-09-26', end: '2026-10-03' },
    { id: 'w2', name: '第2周', start: '2026-10-04', end: '2026-10-10' },
    { id: 'w3', name: '第3周', start: '2026-10-11', end: '2026-10-17' },
    { id: 'w4', name: '第4周', start: '2026-10-18', end: '2026-10-25' },
  ],
};

test('提交快照按日报日截止，按个人、本店、市场分别冻结五项实际累计', async () => {
  const calls = [];
  const query = async (sql, params = []) => {
    calls.push({ sql, params });
    if (sql.includes('FROM daily_operating_periods')) return [period];
    if (sql.includes('FROM ancestors WHERE type=\'市场\'')) return [{ id: 'm1' }];
    if (sql.includes('FROM stores WHERE org_node_id IN')) return [{ store_id: 's1' }, { store_id: 's2' }];
    if (sql.includes('FROM staff_wechat_users WHERE store_id')) return [{ employee_id: 'e1' }, { employee_id: 'e2' }];
    if (sql.includes('WITH selected AS')) return [
      { scope: 'personal', id: 'e1', date: '2026-10-04', sales: 12000, consumption: 8000, visits: 2, newCustomers: 1, projects: 3 },
      { scope: 'store', id: 's1', date: '2026-10-03', sales: 5000, consumption: 4000, visits: 2, newCustomers: 1, projects: 2 },
      { scope: 'store', id: 's1', date: '2026-10-04', sales: 10000, consumption: 7000, visits: 3, newCustomers: 1, projects: 5 },
      { scope: 'store', id: 's2', date: '2026-10-04', sales: 20000, consumption: 9000, visits: 4, newCustomers: 1, projects: 7 },
    ];
    if (sql.includes('WITH first_visit AS')) return [
      { client_user_id: 'c1', date: '2026-10-04', store_id: 's1' },
      { client_user_id: 'c1', date: '2026-10-04', store_id: 's2' },
      { client_user_id: 'c2', date: '2026-10-03', store_id: 's1' },
      { client_user_id: 'c3', date: '2026-10-05', store_id: 's1' },
    ];
    throw Error('Unexpected query: ' + sql.slice(0, 80));
  };
  const auth = {
    employeeId: 'e1', storeId: 's1',
    managerStores: [{ store_id: 's1' }],
  };
  const snapshot = await metrics.captureReportSnapshot(query, auth, {
    date: '2026-10-04', workspace: 'manager',
  });
  assert.equal(snapshot.scope, 'store');
  assert.deepEqual(snapshot.scopes.personal.day, {
    sales: 12000, consumption: 8000, visits: 2, newCustomers: 1, projects: 3,
  });
  assert.deepEqual(snapshot.scopes.store.week, {
    sales: 10000, consumption: 7000, visits: 3, newCustomers: 1, projects: 5,
  });
  assert.deepEqual(snapshot.scopes.market.day, {
    sales: 30000, consumption: 16000, visits: 7, newCustomers: 1, projects: 12,
  });
  assert.deepEqual(snapshot.scopes.market.week, {
    sales: 30000, consumption: 16000, visits: 7, newCustomers: 1, projects: 12,
  });
  const seriesCall = calls.find((call) => call.sql.includes('WITH selected AS'));
  assert.equal(seriesCall.params[3], '2026-10-04');
  assert.match(seriesCall.sql, /CROSS JOIN LATERAL/);
  assert.match(seriesCall.sql, /so\.client_user_id=clients\.client_user_id/);
  const newCustomerCall = calls.find((call) => call.sql.includes('WITH first_visit AS'));
  assert.equal(newCustomerCall.params[2], '2026-10-04');
});

test('日报详情只返回当前工作台有权看的快照范围', () => {
  const snapshot = { scope: 'personal', month: { sales: { done: 101 } }, scopes: {
    personal: { scope: 'personal', scopeId: 'e1', day: { sales: 1 }, week: null, month: null },
    store: { scope: 'store', scopeId: 's1', day: { sales: 2 }, week: null, month: { sales: 20 } },
    market: { scope: 'market', scopeId: 'm1', day: { sales: 3 }, week: null, month: { sales: 30 } },
  } };
  const report = { employee_id: 'e1', store_id: 's1' };
  const personal = metrics.reportSnapshotForViewer(snapshot, { employeeId: 'e1' }, report, 'employee');
  assert.equal(personal.day.sales, 1);
  assert.equal(personal.scopes, undefined);
  const store = metrics.reportSnapshotForViewer(snapshot, { managerStores: [{ store_id: 's1' }] }, report, 'manager');
  assert.equal(store.day.sales, 2);
  assert.equal(store.month.sales, 20);
  const marketAuth = {
    availableWorkspaces: ['employee', 'management'],
    roleBindings: [{ scopeType: '市场', scopeId: 'm1', actions: ['data_center:dashboard'] }],
  };
  const market = metrics.reportSnapshotForViewer(snapshot, marketAuth, report, 'management');
  assert.equal(market.day.sales, 3);
  assert.equal(metrics.reportSnapshotForViewer(snapshot, {
    availableWorkspaces: ['employee', 'management'], roleBindings: [],
  }, report, 'management'), null);
});
