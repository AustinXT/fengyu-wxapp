const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('../../../node_modules/typescript');
function home(api) {
  let page;
  const source = fs.readFileSync(path.join(__dirname, '../../../miniprogram/pages/home/home.ts'), 'utf8');
  vm.runInNewContext(ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS } }).outputText, {
    exports: {}, Page(p) { page = p; },
    require: () => ({ callApi: api, today: () => '2026-10-03', showError() {}, syncTabs() {},
      login: async () => ({ user: { employeeId: 'self', name: '员工' }, workspace: 'employee' }) }),
  });
  page.data = { ...page.data };
  page.setData = function(patch) { Object.assign(this.data, patch); };
  return page;
}
const tick = () => new Promise(resolve => setImmediate(resolve));
test('首页三项并行读取，状态先显示，返回时保留已有内容并防重复加载', async () => {
  const pending = {}, calls = [];
  const page = home(action => { calls.push(action); return new Promise(resolve => { pending[action] = resolve; }); });
  const load = page.load();
  await tick();
  assert.deepEqual(calls, ['target.read', 'report.status', 'report.history']);
  assert.equal(page.data.loading, false);
  pending['report.status']({ status: 'submitted' });
  await tick();
  assert.equal(page.data.status, '已提交');
  assert.equal(page.data.statusLoading, false);
  assert.equal(page.data.goalLoading, true);
  pending['report.history']({ reports: [{ id: 'recent' }] });
  pending['target.read']({ period: null, week: null, target: null });
  await load;
  const refresh = page.load();
  await tick();
  assert.equal(page.data.loading, false);
  assert.equal(page.data.recent[0].id, 'recent');
  await page.load();
  assert.equal(calls.length, 6);
  pending['report.status']({ status: 'draft' });
  pending['report.history']({ reports: [] });
  pending['target.read']({ period: null, week: null, target: null });
  await refresh;
  assert.equal(page.data.status, '草稿');
});
test('目标失败不阻断今日状态和历史，刷新标志最终恢复', async () => {
  const page = home(async action => {
    if (action === 'target.read') throw Error('网络错误');
    return action === 'report.status' ? { status: null } : { reports: [{ id: 'history' }] };
  });
  await page.load();
  assert.equal(page.data.goalError, true);
  assert.equal(page.data.error, false);
  assert.equal(page.data.status, '未填写');
  assert.equal(page.data.recent[0].id, 'history');
  assert.equal(page.data.refreshing, false);
});
