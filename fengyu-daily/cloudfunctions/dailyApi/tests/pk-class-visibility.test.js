const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { participantObjects } = require('../utils/operating-objects');
const period = { id: 'p1', start: '2026-10-01', end: '2026-10-28', weeks: [
  { id: 'w1', start: '2026-10-01', end: '2026-10-07' },
] };
const assignments = ['s1', 's2'].map(store_id => ({ store_id, class_id: 'c1', legion: '红军' }));
function handlers() {
  const module = { exports: {} };
  const query = async (sql, args) => {
    if (sql.includes('FROM daily_pk_classes')) {
      const allowed = sql.includes('WHERE c.id=$1') ? args[2] : args[1];
      if (!allowed.includes('s1') && !allowed.includes('s2')) return [];
      if (sql.includes('WHERE c.id=$1') && args[0] !== 'c1') return [];
      return [{ id: 'c1', name: '跨店班级' }];
    }
    if (sql.includes('FROM daily_pk_stores')) {
      assert.equal(args[0], 'p1');
      assert.ok(args[1] === 'c1' || args[1].includes('c1'));
      return assignments;
    }
    if (sql.includes('FROM daily_operating_targets')) return [];
    throw Error(sql);
  };
  vm.runInNewContext(fs.readFileSync(require.resolve('../routes/pk'), 'utf8'), {
    module, require(name) {
      if (name === '../db/pg') return { query };
      if (name === './period') return { resolve: async () => ({ date: '2026-10-07', period, week: period.weeks[0] }) };
      if (name === './target') return { expand: value => value };
      if (name === '../utils/operating-visibility') return { visibleStores: async auth => auth.stores };
      if (name === '../utils/operating-objects') return {
        participantObjects,
        directory: async (_query, stores) => {
          assert.deepEqual(Array.from(stores), ['s1', 's2']);
          return { fullMarkets: [], stores: stores.map(id => ({ id, name: id, area: '区域' })),
            people: stores.map((storeId, i) => ({ employeeId: 'e' + i, name: '人员' + i, storeId, manager: i === 0 })) };
        },
      };
      if (name === '../utils/operating-series') return {
        series: async (_query, { storeIds }) => {
          assert.deepEqual(Array.from(storeIds), ['s1', 's2']);
          return [{ scope: 'store', id: 's1', date: '2026-10-07', sales: 20000 },
            { scope: 'personal', id: 'e1', date: '2026-10-07', sales: 10000 }];
        }, marketNewCustomers: async () => [],
      };
      return require(name);
    },
  });
  return module.exports;
}
test('同班员工、店长和管理者看到一致的全班人数、完成值与排名，其他班级仍拒绝访问', async () => {
  const pk = handlers(), boards = [], lists = [];
  for (const stores of [['s1'], ['s2'], ['s1', 's2']]) {
    const ctx = { auth: { stores }, event: { payload: { classId: 'c1', metric: 'sales' } } };
    await pk.classes(ctx); lists.push(JSON.stringify(ctx.result.classes));
    assert.equal(ctx.result.classes[0].members, 2);
    assert.equal(ctx.result.classes[0].stores, 2);
    await pk.read(ctx); boards.push(JSON.stringify(ctx.result.rows));
    assert.equal(ctx.result.rows.length, 2);
    assert.equal(ctx.result.rows[0].sales.weekDone, 20000);
    assert.equal(ctx.result.rows[1].sales.weekDone, 10000);
  }
  assert.equal(new Set(lists).size, 1);
  assert.equal(new Set(boards).size, 1);
  await assert.rejects(pk.read({ auth: { stores: ['other'] }, event: { payload: { classId: 'c1' } } }), /无权查看/);
  await assert.rejects(pk.read({ auth: { stores: ['s1'] }, event: { payload: { classId: 'other' } } }), /无权查看/);
});
