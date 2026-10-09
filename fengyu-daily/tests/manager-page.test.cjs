const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');
const code = ts.transpileModule(fs.readFileSync(path.join(__dirname, '../miniprogram/pages/manager/manager.ts'), 'utf8'),
  { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 } }).outputText;
function boot() {
  let page;
  const calls = [], navigation = [], errors = [];
  vm.runInNewContext(code, { exports: {}, Page: value => { page = value; }, wx: {
    navigateTo: value => navigation.push(value),
  }, require: name => name.endsWith('/route') ? { decodeRouteId: value => value || '' } : {
    today: () => '2026-10-09', showError: error => errors.push(error),
    callApi: async (action, payload) => { calls.push({ action, payload }); return {
      stores: [{ store_id: 'a', store_name: '甲店' }], storeId: 'a',
      summary: { due: 2, submitted: 1 }, range: { kind: payload.period },
      employees: [{ employee_id: 'submitted', name: '已交员工' }, { employee_id: 'missing', name: '未交员工' }],
      reports: [{ id: 'report', employee_id: 'submitted' }], unsubmitted: [],
    }; },
  } });
  page.setData = value => Object.assign(page.data, value);
  return { page, calls, navigation, errors };
}
test('门店员工今日行内直达日报；员工行保留历史入口；周月不误打开单份日报', async () => {
  const { page, calls, navigation, errors } = boot();
  page.onLoad({ storeId: 'a' });
  await page.load();
  assert.equal(calls[0].payload.storeId, 'a');
  assert.equal(page.data.title, '甲店日报');
  assert.equal(page.data.employeeRows[0].directReportId, 'report');
  assert.equal(page.data.employeeRows[1].directReportId, '');
  page.open({ currentTarget: { dataset: { id: 'report' } } });
  page.person({ currentTarget: { dataset: { id: 'missing' } } });
  assert.match(navigation[0].url, /detail.*id=report/);
  assert.match(navigation[1].url, /history.*employeeId=missing/);
  for (const period of ['week', 'month']) {
    page.setData({ period }); await page.load();
    assert.ok(page.data.employeeRows.every(employee => employee.directReportId === ''));
    assert.equal(calls.at(-1).payload.storeId, 'a');
  }
  assert.equal(errors.length, 0);
});
