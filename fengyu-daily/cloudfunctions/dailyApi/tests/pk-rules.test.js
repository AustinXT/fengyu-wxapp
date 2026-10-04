const test = require('node:test');
const assert = require('node:assert/strict');
const { validateClasses, rankRows } = require('../utils/pk-rules');

test('同月门店不可跨班或重复，班级名称与编号唯一', () => {
  assert.deepEqual(validateClasses([{ id: 'a', name: ' 红军班 ', storeIds: ['S1'] }])[0].name, '红军班');
  for (const classes of [
    [{ id: 'a', name: 'A', storeIds: ['S1', 'S1'] }],
    [{ id: 'a', name: 'A', storeIds: ['S1'] }, { id: 'b', name: 'B', storeIds: ['S1'] }],
    [{ id: 'a', name: 'A', storeIds: [] }, { id: 'a', name: 'B', storeIds: [] }],
    [{ id: 'a', name: 'A', storeIds: [] }, { id: 'b', name: ' A ', storeIds: [] }],
  ]) assert.throws(() => validateClasses(classes));
});

test('业绩与消耗独立按周完成率排序，未设置及零目标不产生虚假完成率', () => {
  const rows = [
    { id: 'A', sales: { weekTarget: 100, weekDone: 80 }, consumption: { weekTarget: 100, weekDone: 120 } },
    { id: 'B', sales: { weekTarget: 100, weekDone: 120 }, consumption: { weekTarget: 100, weekDone: 80 } },
    { id: 'C', sales: { weekTarget: null, weekDone: 1000 }, consumption: { weekTarget: 0, weekDone: 1000 } },
  ];
  assert.deepEqual(rankRows(rows, 'sales').map((x) => x.id), ['B', 'A', 'C']);
  assert.deepEqual(rankRows(rows, 'consumption').map((x) => x.id), ['A', 'B', 'C']);
  assert.equal(rows[0].rank, undefined);
});

test('整数交叉乘法在金额较大时仍准确识别相近完成率', () => {
  const n = Number.MAX_SAFE_INTEGER;
  const rows = [
    { id: 'less', sales: { weekTarget: n, weekDone: n - 1 } },
    { id: 'full', sales: { weekTarget: n, weekDone: n } },
  ];
  assert.equal(rankRows(rows, 'sales')[0].id, 'full');
  assert.throws(() => rankRows(rows, 'unknown'));
});

test('客量、新客、项目数也按周目标完成率排序', () => {
  const rows = [
    { id: 'A', visits: { weekTarget: 10, weekDone: 5 }, newCustomers: { weekTarget: 4, weekDone: 3 }, projects: { weekTarget: 20, weekDone: 10 } },
    { id: 'B', visits: { weekTarget: 10, weekDone: 8 }, newCustomers: { weekTarget: 4, weekDone: 2 }, projects: { weekTarget: 20, weekDone: 15 } },
    { id: 'C', visits: { weekTarget: null, weekDone: 100 }, newCustomers: { weekTarget: 0, weekDone: 100 }, projects: { weekTarget: null, weekDone: 100 } },
  ];
  assert.deepEqual(rankRows(rows, 'visits').map((x) => x.id), ['B', 'A', 'C']);
  assert.deepEqual(rankRows(rows, 'newCustomers').map((x) => x.id), ['A', 'B', 'C']);
  assert.deepEqual(rankRows(rows, 'projects').map((x) => x.id), ['B', 'A', 'C']);
});
