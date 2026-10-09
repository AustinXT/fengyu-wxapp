const { test } = require('node:test');
const assert = require('node:assert/strict');
const pg = require('../db/pg');
const submissions = require('../utils/submission-range');
const management = require('../routes/management');

async function readWith(t, { nodes = [], stores = [], ancestors = [], includeOrganization = true, authorized = true } = {}) {
  const original = { query: pg.query, range: submissions.range, people: submissions.people };
  const queries = [];
  pg.query = async (sql, args) => {
    queries.push({ sql, args });
    return sql.includes('WITH RECURSIVE') ? ancestors : nodes;
  };
  submissions.range = async () => ({ date: '2026-10-09', start: '2026-10-09', end: '2026-10-09', kind: 'today' });
  submissions.people = async () => [];
  t.after(() => Object.assign(pg, { query: original.query }));
  t.after(() => Object.assign(submissions, { range: original.range, people: original.people }));
  const ctx = { event: { payload: { includeOrganization } }, auth: {
    availableWorkspaces: authorized ? ['management'] : ['employee'], scopeOrgNodeIds: nodes.map(n => n.id), scopedStores: stores,
  } };
  return { ctx, queries, run: async () => { await management.read(ctx); return ctx.result; } };
}

test('仅门店授权也能按祖先市场分组，且只查授权门店参数', async t => {
  const { run, queries } = await readWith(t, {
    nodes: [{ id: 'n1', type: '门店', parent_id: 'department' }],
    stores: [{ store_id: 's1', org_node_id: 'n1' }, { store_id: 's2', org_node_id: 'n2' }],
    ancestors: [{ store_id: 's1', id: 'market-a', name: '市场甲' }, { store_id: 's2', id: 'market-b', name: '市场乙' },
      { store_id: 'not-authorized', id: 'outside', name: '越权市场' }],
  });
  const result = await run();
  assert.deepEqual(result.organizationMarkets.map(m => [m.id, m.storeIds]), [['market-a', ['s1']], ['market-b', ['s2']]]);
  assert.deepEqual(queries[1].args, [['s1', 's2']]);
  assert.match(queries[1].sql, /ANY\(\$1::text\[\]\)/);
  assert.match(queries[1].sql, /NOT n.id=ANY\(a.path\)/);
  assert.deepEqual(result.stores.map(s => s.store_id), ['s1', 's2']);
});
test('空市场保留，未归属门店不丢失；无员工不隐藏市场选项', async t => {
  const { run } = await readWith(t, { nodes: [{ id: 'empty', name: '空市场', type: '市场' }], stores: [{ store_id: 'orphan', org_node_id: null }] });
  assert.deepEqual((await run()).organizationMarkets, [
    { id: 'empty', name: '空市场', storeIds: [] }, { id: '__unassigned__', name: '未归属市场', storeIds: ['orphan'] },
  ]);
});
test('总览原调用不加查询或字段', async t => {
  const { run, queries } = await readWith(t, { includeOrganization: false, stores: [{ store_id: 's1' }] });
  assert.equal((await run()).organizationMarkets, undefined);
  assert.equal(queries.length, 1);
});
test('非管理层账号在查询前拒绝', async t => {
  const { run, queries } = await readWith(t, { authorized: false });
  await assert.rejects(run(), /PERMISSION_DENIED/);
  assert.equal(queries.length, 0);
});
