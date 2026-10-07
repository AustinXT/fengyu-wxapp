const test = require('node:test');
const assert = require('node:assert/strict');
const { validatePeriod, weekForDate } = require('../utils/operating-period');
const { resolve } = require('../routes/period');
const fixture = () => ({ start: '2026-06-26', end: '2026-07-25', weeks: [
  { id: 'w1', start: '2026-06-26', end: '2026-07-02' },
  { id: 'w2', start: '2026-07-03', end: '2026-07-09' },
  { id: 'w3', start: '2026-07-10', end: '2026-07-17' },
  { id: 'w4', start: '2026-07-18', end: '2026-07-25' },
] });

test('不等长四周覆盖整月，调整边界后日期归属随配置变化', () => {
  const period = fixture();
  assert.equal(weekForDate(period, '2026-07-06').id, 'w2');
  period.weeks[0].end = '2026-07-06';
  period.weeks[1].start = '2026-07-07';
  assert.equal(weekForDate(period, '2026-07-06').id, 'w1');
  assert.equal(weekForDate(period, '2026-07-26'), null);
});

test('拒绝间隙、重叠、缺周、非法自然日及不完整覆盖', () => {
  const change = [
    (p) => { p.weeks[1].start = '2026-07-04'; },
    (p) => { p.weeks[1].start = '2026-07-02'; },
    (p) => { p.weeks.pop(); },
    (p) => { p.start = '2026-02-30'; },
    (p) => { p.weeks[3].end = '2026-07-24'; },
    (p) => { p.weeks[1].id = 'w1'; },
  ];
  for (const mutate of change) { const p = fixture(); mutate(p); assert.throws(() => validatePeriod(p)); }
});

test('门店按经营月快照选择区域周期，并在无区域周期时回退全局周期', async () => {
  const global = { id: 'global', name: '全局', start_date: fixture().start, end_date: fixture().end, weeks: fixture().weeks, version: 1, region_id: null };
  const regional = { ...global, id: 'regional', name: '区域', region_id: 'old-market' };
  const query = async () => [global, regional];
  const resolved = await resolve(query, { date: '2026-07-06' }, { storeId: 's1' });
  assert.equal(resolved.period.id, 'regional');
  const fallback = await resolve(async () => [global], { date: '2026-07-06' }, { storeId: 's2' });
  assert.equal(fallback.period.id, 'global');
});
