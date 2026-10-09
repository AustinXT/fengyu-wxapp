const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');
const code = ts.transpileModule(fs.readFileSync(path.join(__dirname, '../miniprogram/pages/workbench/workbench.ts'), 'utf8'),
  { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 } }).outputText;
function boot() {
  let page;
  const calls = [], errors = [], navigation = [];
  const state = { user: { employeeId: 'manager' }, response: {
    nodes: [], markets: [], employees: [], stores: [
      { store_id: 'a', store_name: '甲店', org_node_id: 'node-a' },
      { store_id: 'b', store_name: '乙店', org_node_id: 'node-b' },
    ], organizationMarkets: [
      { id: 'empty', name: '空市场', storeIds: [] },
      { id: 'market-a', name: '甲市场', storeIds: ['a'] },
      { id: 'market-b', name: '乙市场', storeIds: ['b'] },
    ],
  } };
  vm.runInNewContext(code, { exports: {}, Page: value => { page = value; }, wx: {
    navigateTo: value => navigation.push(value), switchTab() {},
  }, require: name => name.endsWith('/session') ? { identityContext: () => 'identity', sessionContext: () => 'session', sessionChanged: () => Error('session changed') } : name.endsWith('/cloud') ? {
    callApi: async (action, payload) => { calls.push({ action, payload }); return structuredClone(state.response); },
    showError: error => errors.push(error), today: () => '2026-10-09',
  } : { login: async () => ({ user: state.user, workspace: 'management' }), syncTabs() {} } });
  page.setData = value => Object.assign(page.data, value);
  return { page, state, calls, errors, navigation };
}
const ids = page => Array.from(page.data.visibleStores, store => store.store_id);
test('默认有门店市场；同页切换无需请求；返回重新加载仍保留选择', async () => {
  const { page, calls, navigation, errors } = boot();
  await page.load();assert.deepEqual(ids(page), ['a']);assert.equal(calls[0].payload.includeOrganization, true);
  page.organizationMarketChange({ detail: { value: '2' } });assert.deepEqual(ids(page), ['b']);assert.equal(calls.length, 1);
  page.store({ currentTarget: { dataset: { id: 'b' } } });assert.match(navigation[0].url, /storeId=b/);
  await page.load();assert.deepEqual(ids(page), ['b']);assert.equal(errors.length, 0);
  page.organizationMarketChange({ detail: { value: '99' } });assert.deepEqual(ids(page), ['b']);
});
test('权限移除或身份切换后不沿用旧市场；空授权清空门店', async () => {
  const { page, state } = boot();await page.load();page.organizationMarketChange({ detail: { value: '2' } });
  state.response.organizationMarkets = state.response.organizationMarkets.slice(0, 2);
  await page.load();assert.deepEqual(ids(page), ['a']);
  state.response.organizationMarkets.push({ id: 'market-b', name: '乙市场', storeIds: ['b'] });
  page.organizationMarketChange({ detail: { value: '2' } });state.user = { employeeId: 'other' };
  await page.load();assert.deepEqual(ids(page), ['a']);
  state.response.organizationMarkets = [];state.response.stores = [];
  await page.load();assert.deepEqual(ids(page), []);assert.equal(page.data.organizationMarketId, '');
});
test('旧云函数缺少市场字段时保留授权门店；服务更新后恢复市场分组', async () => {
  const { page, state, errors, navigation } = boot();
  const markets = state.response.organizationMarkets;
  delete state.response.organizationMarkets;
  await page.load();
  assert.equal(errors.length, 0);
  assert.equal(page.data.ready, true);
  assert.equal(page.data.organizationCompatibility, true);
  assert.deepEqual(ids(page), ['a', 'b']);
  page.store({ currentTarget: { dataset: { id: 'a' } } });
  assert.match(navigation[0].url, /storeId=a/);
  state.response.organizationMarkets = null;
  await page.load();
  assert.deepEqual(ids(page), ['a', 'b']);
  assert.equal(errors.length, 0);
  state.response.organizationMarkets = markets;
  await page.load();
  assert.equal(page.data.organizationCompatibility, false);
  assert.deepEqual(ids(page), ['a']);
});

test('组织与人员共享市场；门店筛选联动并在换市场后复位', async () => {
  const { page, state } = boot();
  state.response.employees = [
    { employee_id: 'ea', name: '甲员工', store_id: 'a' },
    { employee_id: 'eb', name: '乙员工', store_id: 'b' },
  ];
  await page.load();
  assert.deepEqual(Array.from(page.data.peopleStores, store => store.store_id), ['', 'a']);
  page.peopleFilter({ currentTarget: { dataset: { kind: 'store' } }, detail: { value: '1' } });
  page.peopleFilter({ currentTarget: { dataset: { kind: 'market' } }, detail: { value: '2' } });
  assert.equal(page.data.peopleStoreIndex, 0);
  assert.deepEqual(ids(page), ['b']);
  assert.deepEqual(Array.from(page.data.peopleStores, store => store.store_id), ['', 'b']);
  assert.deepEqual(Array.from(page.data.visibleEmployees, employee => employee.employee_id), ['eb']);
  page.orgChange({ currentTarget: { dataset: { view: 'tree' } } });
  assert.equal(page.data.organizationMarketId, 'market-b');
  await page.load();
  assert.equal(page.data.peopleMarketIndex, 2);
});
