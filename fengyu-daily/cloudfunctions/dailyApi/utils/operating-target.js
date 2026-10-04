// V2 原型目标规则。所有金额先转为分，避免第 4 周余额出现浮点误差。
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

// 第一至第三周目标未齐全时，第四周保持未设置；不把空值当作零。
function weeklyTargets(monthCents, firstThree) {
  if (!Number.isSafeInteger(monthCents) || monthCents <= 0 ||
      !Array.isArray(firstThree) || firstThree.length !== 3)
    throw Error('INVALID_PARAMS: 无效月周目标');
  for (const value of firstThree) {
    if (value !== null && (!Number.isSafeInteger(value) || value < 0))
      throw Error('INVALID_PARAMS: 周目标必须是非负金额');
  }
  const used = firstThree.reduce((sum, value) => sum + (value ?? 0), 0);
  if (!Number.isSafeInteger(used) || used > monthCents)
    throw Error('INVALID_PARAMS: 前三周目标累计不能超过月目标');
  return [...firstThree, firstThree.includes(null) ? null : monthCents - used];
}

module.exports = { cents, validateMonth, weeklyTargets };
