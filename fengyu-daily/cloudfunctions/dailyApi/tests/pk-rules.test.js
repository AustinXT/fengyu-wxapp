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

test('双指标排名沿用各指标服务端规则，同率原序、零目标与未设置均精确一致', () => {
  const { rankBothMetrics } = require('../utils/pk-rules');
  const values = (done,target) => ({ weekDone:done,weekTarget:target });
  const rows = [
    {id:'A',sales:values(100,100),consumption:values(50,100)},
    {id:'B',sales:values(50,100),consumption:values(100,100)},
    {id:'C',sales:values(200,200),consumption:values(100,200)},
    {id:'zero',sales:values(100,0),consumption:values(100,null)},
    {id:'unset',sales:values(100,null),consumption:values(100,0)},
  ];
  for (const metric of ['sales','consumption']) {
    const result=rankBothMetrics(rows,metric);
    assert.deepEqual(result.map(r=>r.id),rankRows(rows,metric).map(r=>r.id));
    for(const other of ['sales','consumption']) {
      const local=[...result].sort((a,b)=>a.rankByMetric[other]-b.rankByMetric[other]);
      assert.deepEqual(local.map(r=>r.id),rankRows(rows,other).map(r=>r.id));
    }
    assert.equal(result.some(r=>'_rankIndex' in r),false);
  }
});
