const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('../../../node_modules/typescript');

function editor(api, confirm = true) {
  let page;
  const messages = [];
  const wx = {
    enableAlertBeforeUnload() {},
    showToast(options) { messages.push(options.title); },
    async showModal() { return { confirm }; },
  };
  const source = fs.readFileSync(path.join(__dirname, '../../../miniprogram/pages/report/report.ts'), 'utf8');
  const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS } }).outputText;
  vm.runInNewContext(compiled, {
    exports: {}, wx,
    require: () => ({ callApi: api, today: () => '2026-10-03', showError: (e) => { throw e; } }),
    Page(config) { page = config; },
  });
  page.data = { ...page.data, ready: true, entries: [{ businessId: 'today', feedback: '当天反馈' }] };
  page.setData = function(patch) { Object.assign(this.data, patch); };
  return { page, messages };
}

test('复制已提交整日补充，不改变当日业务、版本和提交状态，也不自动保存', async () => {
  const calls = [];
  const { page } = editor(async (action, payload) => {
    calls.push([action, payload.date]);
    return { report: { report_date: '2026-10-01', action: '回访', growth: '沟通', plan: '预约' } };
  });
  const entries = page.data.entries;
  await page.copyLast();
  assert.equal(page.data.action, '回访');
  assert.equal(page.data.entries, entries);
  assert.equal(page.data.entries[0].feedback, '当天反馈');
  assert.equal(page.data.version, 0);
  assert.equal(page.data.status, 'draft');
  assert.equal(page.data.dirty, true);
  assert.equal(page.data.copying, false);
  assert.deepEqual(calls, [['report.previous', '2026-10-03']]);
});

test('取消覆盖保留本次编辑，暂无上次提交时保留原内容', async () => {
  const { page } = editor(async () => ({ report: { action: '旧内容', growth: '', plan: '' } }), false);
  page.data.action = '本次内容';
  await page.copyLast();
  assert.equal(page.data.action, '本次内容');
  assert.equal(page.data.dirty, false);
  const empty = editor(async () => ({ report: null }));
  await empty.page.copyLast();
  assert.equal(empty.page.data.dirty, false);
  assert.equal(empty.messages[0], '暂无可复制的已提交记录');
});

test('复制期间阻止重复请求、输入、保存和切换日期，历史只读不能复制', async () => {
  let finish, requests = 0;
  const { page } = editor(() => { requests++; return new Promise((resolve) => { finish = resolve; }); });
  const pending = page.copyLast();
  await page.copyLast();
  page.input({ currentTarget: { dataset: { field: 'action' } }, detail: { value: '并发编辑' } });
  page.changeDate({ detail: { value: '2026-10-02' } });
  await page.write(false);
  assert.equal(requests, 1);
  assert.equal(page.data.action, '');
  assert.equal(page.data.date, '2026-10-03');
  finish({ report: null });
  await pending;
  page.data.readOnly = true;
  await page.copyLast();
  assert.equal(requests, 1);
});

test('上次补充查询只采用服务端员工身份，参数化查询且不返回业务明细', async () => {
  const pg = require('../db/pg');
  const original = pg.query;
  try {
    pg.query = async (sql, params) => {
      assert.match(sql, /employee_id=\$1 AND report_date<\$2 AND status='submitted'/);
      assert.match(sql, /ORDER BY report_date DESC LIMIT 1/);
      assert.deepEqual(params, ['trusted-employee', '2026-10-02']);
      return [{ report_date: '2026-10-01', action: '行动', growth: '', plan: '' }];
    };
    const ctx = { auth: { employeeId: 'trusted-employee' }, event: { payload: { date: '2026-10-02', employeeId: 'forged' } } };
    await require('../routes/report').previous(ctx);
    assert.equal(ctx.result.report.action, '行动');
    assert.equal(ctx.result.report.entries, undefined);
  } finally { pg.query = original; }
});
