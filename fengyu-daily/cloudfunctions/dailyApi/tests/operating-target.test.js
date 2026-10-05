const test = require('node:test');
const assert = require('node:assert/strict');
const { cents, validateMonth, weeklyTargets } = require('../utils/operating-target');

test('月目标与个人负激励按原型校验，非个人目标不保留负激励', () => {
  assert.deepEqual(validateMonth({ sales: '100.01', consumption: '50', penalty: '复盘' }, 'personal'),
    { sales: 10001, consumption: 5000, penalty: '复盘' });
  assert.throws(() => validateMonth({ sales: '0', consumption: '50', penalty: '复盘' }, 'personal'));
  assert.throws(() => validateMonth({ sales: '100', consumption: '50', penalty: '' }, 'personal'));
  assert.equal(validateMonth({ sales: '100', consumption: '50', penalty: '不适用' }, 'store').penalty, '');
});

test('第四周精确取余额，未设置与明确的零目标有不同含义', () => {
  assert.deepEqual(weeklyTargets(cents('0.30'), [cents('0.10'), cents('0.20'), 0]), [10, 20, 0, 0]);
  assert.deepEqual(weeklyTargets(10000, [1000, null, 0]), [1000, null, 0, null]);
  assert.throws(() => weeklyTargets(10000, [10000, 1, null]), /不能超过/);
  assert.throws(() => weeklyTargets(10000, [-1, 0, 0]));
});

test('拒绝非法、过精度和超安全范围金额', () => {
  for (const value of ['', null, true, '-1', '1e3', '1.001', 'Infinity', '9007199254740991'])
    assert.throws(() => cents(value));
});
