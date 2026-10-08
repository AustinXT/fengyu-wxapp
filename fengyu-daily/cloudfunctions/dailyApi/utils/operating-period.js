function date(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value))
    throw Error('INVALID_PARAMS: 无效经营日期');
  const stamp = Date.parse(`${value}T12:00:00Z`);
  if (!Number.isFinite(stamp) || new Date(stamp).toISOString().slice(0, 10) !== value)
    throw Error('INVALID_PARAMS: 无效经营日期');
  return stamp;
}

function validatePeriod(input) {
  const start = date(input.start), end = date(input.end);
  if (start > end || !Array.isArray(input.weeks) || input.weeks.length < 1 || input.weeks.length > 31)
    throw Error('INVALID_PARAMS: 经营月需配置1至31个有效经营周');
  let expected = start;
  const ids = new Set();
  for (const week of input.weeks) {
    if (typeof week.id !== 'string' || !week.id || ids.has(week.id))
      throw Error('INVALID_PARAMS: 经营周编号不能为空或重复');
    ids.add(week.id);
    const from = date(week.start), to = date(week.end);
    if (from !== expected || from > to || to > end)
      throw Error('INVALID_PARAMS: 经营周必须连续、无重叠地覆盖经营月');
    expected = to + 86400000;
  }
  if (expected !== end + 86400000)
    throw Error('INVALID_PARAMS: 经营周必须覆盖完整经营月');
  return input;
}

function weekForDate(period, value) {
  validatePeriod(period);
  date(value);
  return period.weeks.find((week) => week.start <= value && value <= week.end) || null;
}

module.exports = { validatePeriod, weekForDate };
