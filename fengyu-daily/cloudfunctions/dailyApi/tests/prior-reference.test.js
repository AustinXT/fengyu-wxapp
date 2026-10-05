const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');

function load(rows) {
  const calls = [], exports = {};
  const sandbox = { module: { exports }, require: (path) => {
    if (path === '../routes/period') return { normalize: (row) => row };
    if (path === '../routes/metrics') return {
      scopeStores: async () => ['authorized-store'],
      totals: async (_query, _scope, stores, start, end) => {
        calls.push({ stores, start, end }); return { sales: 100, consumption: 200 };
      },
    };
    throw Error(path);
  } };
  vm.runInNewContext(fs.readFileSync(require.resolve('../utils/prior-reference'), 'utf8'), sandbox);
  return { calls, reference: sandbox.module.exports.reference,
    query: async (_sql, params) => { calls.push(params); return rows; } };
}

test('跨自然年的经营月按名称年份映射，名称匹配优先于开始月日', async () => {
  const named = { name: '2025年1月', start: '2024-12-25', end: '2025-01-24', weeks: [{ start: '2024-12-25', end: '2024-12-31' }] };
  const fixture = load([named, { name: '其他经营月', start: '2024-12-26' }]);
  const result = await fixture.reference(fixture.query, {}, {}, {
    name: '2026年1月', start: '2025-12-26', weeks: [{ id: 'w1' }],
  }, { id: 'w1' });
  assert.deepEqual(Array.from(fixture.calls[0]), [2024, '2025年1月', '12-26']);
  assert.equal(result.period.name, '2025年1月');
  assert.equal(fixture.calls[1].start, '2024-12-25');
  assert.equal(result.week.sales, 100);
});

test('去年配置不存在或对应关系含糊时不查询业绩、不补造参考', async () => {
  for (const rows of [[], [{ name: '同名' }, { name: '同名' }]]) {
    const fixture = load(rows);
    assert.equal(await fixture.reference(fixture.query, {}, {}, {
      name: '经营月', start: '2026-06-26', weeks: [],
    }, null), null);
    assert.equal(fixture.calls.length, 1);
  }
});
