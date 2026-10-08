const test = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const url = require('./test-database').testDatabase();
const pg = require('../db/pg');
const target = require('../routes/target');
const validation = require('../utils/validation');
const dateAdd = (date, days) => new Date(Date.parse(date + 'T12:00:00Z') + days * 86400000).toISOString().slice(0, 10);
test('真实PG目标锁定、并发、前三周上限、第四周余额、周期版本与授权', { skip: !url }, async () => {
  const id = 'target-' + randomUUID().slice(0, 12);
  const realToday = validation.today;
  const now = realToday(), start = dateAdd(now, -21), end = dateAdd(now, 6);
  const weeks = Array.from({ length: 4 }, (_, i) => ({ id: 'w' + (i + 1), name: '第' + (i + 1) + '周', start: dateAdd(start, i * 7), end: dateAdd(start, i * 7 + 6) }));
  const auth = { employeeId: id, managerStores: [], availableWorkspaces: ['employee'], scopeOrgNodeIds: [] };
  const ctx = (payload) => ({ auth, event: { payload: { periodId: id, periodVersion: 1, scope: 'personal', ...payload } } });
  try {
    await pg.query('INSERT INTO daily_operating_periods(id,name,start_date,end_date,weeks) VALUES($1,$2,$3,$4,$5::jsonb)', [id, '测试经营月', start, end, JSON.stringify(weeks)]);
    validation.today = () => start;
    const result = await Promise.allSettled([
      target.confirmMonth(ctx({ version: 0, sales: '100.01', consumption: '200', penalty: '复盘' })),
      target.confirmMonth(ctx({ version: 0, sales: '100.01', consumption: '200', penalty: '复盘' })),
    ]);
    assert.equal(result.filter((r) => r.status === 'fulfilled').length, 1);
    assert.match(result.find((r) => r.status === 'rejected').reason.message, /CONFLICT/);
    await assert.rejects(target.confirmMonth(ctx({ version: 1, sales: '999', consumption: '200', penalty: '覆盖' })), /不可修改/);
    const read = ctx({ date: start }); await target.read(read);
    assert.equal(read.result.target.sales, 10001);
    assert.equal(read.result.target.weeks.w4.sales, null);
    for (let i = 0; i < 3; i++) {
      validation.today = () => weeks[i].start;
      await target.saveWeek(ctx({ version: i + 1, sales: '20', consumption: '40' }));
    }
    const finished = ctx({ date: now }); await target.read(finished);
    assert.equal(finished.result.target.weeks.w4.sales, 4001);
    assert.equal(finished.result.target.weeks.w4.consumption, 8000);
    await assert.rejects(target.saveWeek(ctx({ version: 4, sales: '100', consumption: '40' })), /不能超过/);
    validation.today = () => now;
    await assert.rejects(target.saveWeek(ctx({ version: 4, sales: '20', consumption: '40' })), /自动取剩余/);
    await pg.query('UPDATE daily_operating_periods SET version=2 WHERE id=$1', [id]);
    await assert.rejects(target.saveWeek(ctx({ version: 4, sales: '20', consumption: '40' })), /周期已调整/);
    await assert.rejects(target.read(ctx({ scopeId: 'other-employee' })), /PERMISSION_DENIED/);
    await assert.rejects(target.read(ctx({ scope: 'store', scopeId: 'other-store' })), /PERMISSION_DENIED/);
    await assert.rejects(target.read(ctx({ scope: 'market', scopeId: 'other-market' })), /PERMISSION_DENIED/);
    if (process.env.DAILY_CYCLE_FULL === '1') {
      for (const count of [1, 5]) {
        const variableId = id + '-' + count;
        const variableWeeks = Array.from({ length: count }, (_, i) => ({ id: 'v' + i, name: '周' + (i + 1), start: dateAdd(start, i), end: dateAdd(start, i) }));
        await pg.query('INSERT INTO daily_operating_periods(id,name,start_date,end_date,weeks) VALUES($1,$2,$3,$4,$5::jsonb)', [variableId, '可变周测试', start, dateAdd(start, count - 1), JSON.stringify(variableWeeks)]);
        const variableCtx = payload => ctx({ periodId: variableId, ...payload });
        validation.today = () => start;
        await target.confirmMonth(variableCtx({ version: 0, sales: '100', consumption: '200', penalty: '复盘' }));
        for (let i = 0; i < count - 1; i++) {
          validation.today = () => variableWeeks[i].start;
          await target.saveWeek(variableCtx({ version: i + 1, sales: '10', consumption: '20' }));
        }
        validation.today = () => variableWeeks[count - 1].start;
        const final = variableCtx({ date: validation.today() }); await target.read(final);
        assert.equal(final.result.target.weeks['v' + (count - 1)].sales, (100 - (count - 1) * 10) * 100);
        assert.equal(final.result.target.weeks['v' + (count - 1)].consumption, (200 - (count - 1) * 20) * 100);
        await assert.rejects(target.saveWeek(variableCtx({ version: count, sales: '10', consumption: '20' })), /自动取剩余/);
        await pg.query('DELETE FROM daily_operating_targets WHERE period_id=$1', [variableId]);
        await pg.query('DELETE FROM daily_operating_periods WHERE id=$1', [variableId]);
      }
    }
  } finally {
    validation.today = realToday;
    await pg.query('DELETE FROM daily_operating_targets WHERE period_id=$1', [id]);
    await pg.query('DELETE FROM daily_operating_periods WHERE id=$1', [id]);
    await pg.getPool().end();
  }
});
