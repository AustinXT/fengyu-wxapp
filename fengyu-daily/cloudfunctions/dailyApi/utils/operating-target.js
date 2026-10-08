// V2 原型目标规则。所有金额先转为分，避免最后一周余额出现浮点误差。
function cents(value, positive = false) {
  if (typeof value !== 'number' && typeof value !== 'string')
    throw Error('INVALID_PARAMS: 请填写有效金额');
  const raw = String(value).trim();
  if (!/^\d+(\.\d{1,2})?$/.test(raw))
    throw Error('INVALID_PARAMS: 金额最多保留两位小数');
  const [whole, fraction = ''] = raw.split('.');
  const amount = Number(whole) * 100 + Number(fraction.padEnd(2, '0'));
  if (!Number.isSafeInteger(amount) || (positive && amount <= 0))
    throw Error('INVALID_PARAMS: 月目标必须大于 0，且金额不能超出范围');
  return amount;
}

function validateMonth(input, scope) {
  if (!['personal', 'store', 'market'].includes(scope))
    throw Error('INVALID_PARAMS: 无效目标范围');
  const penalty = String(input.penalty || '').trim();
  if (penalty.length > 500 || (scope === 'personal' && !penalty))
    throw Error('INVALID_PARAMS: 请填写不超过500字的本月负激励');
  return {
    sales: cents(input.sales, true),
    consumption: cents(input.consumption, true),
    penalty: scope === 'personal' ? penalty : '',
  };
}

// 前面各周目标未齐全时，最后一周保持未设置；不把空值当作零。
function weeklyTargets(monthCents, firstThree, allowZero = false) {
  if (!Number.isSafeInteger(monthCents) || (allowZero ? monthCents < 0 : monthCents <= 0) ||
      !Array.isArray(firstThree) || firstThree.length > 30)
    throw Error('INVALID_PARAMS: 无效月周目标');
  for (const value of firstThree) {
    if (value !== null && (!Number.isSafeInteger(value) || value < 0))
      throw Error('INVALID_PARAMS: 周目标必须是非负金额');
  }
  const used = firstThree.reduce((sum, value) => sum + (value ?? 0), 0);
  if (!Number.isSafeInteger(used) || used > monthCents)
    throw Error('INVALID_PARAMS: 前面各周目标累计不能超过月目标');
  return [...firstThree, firstThree.includes(null) ? null : monthCents - used];
}

function count(value) {
  if ((typeof value !== 'number' && typeof value !== 'string') || !/^\d+$/.test(String(value).trim()))
    throw Error('INVALID_PARAMS: 客量、新客、项目数须为非负整数');
  const n = Number(value);
  if (!Number.isSafeInteger(n) || n > 2147483647) throw Error('INVALID_PARAMS: 计数目标超出范围');
  return n;
}
const countKeys = ['visits', 'newCustomers', 'projects'];
function validateCounts(payload) {
  if (countKeys.every((key) => payload[key] === undefined)) return null;
  if (countKeys.some((key) => payload[key] === undefined)) throw Error('INVALID_PARAMS: 请填写完整的三项计数目标');
  return Object.fromEntries(countKeys.map((key) => [key, count(payload[key])]));
}
module.exports = { cents, count, countKeys, validateCounts, validateMonth, weeklyTargets };
