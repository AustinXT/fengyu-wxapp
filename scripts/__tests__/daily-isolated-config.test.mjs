import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateDailyConnection } from '../daily-dev-config.mjs';
test('日报连接仅允许固定独立实例，不允许误连共享库或生产', () => {
  const good = 'postgresql://daily_app:example@101.34.242.103:8151/fengyu_daily_dev';
  assert.equal(validateDailyConnection(good), good);
  for (const wrong of [
    'postgresql://daily_app:example@101.34.242.103:5433/fengyu_wxapp',
    good.replace('101.34.242.103', '118.178.196.26'),
    good.replace('fengyu_daily_dev', 'fengyu_wxapp'),
    good + '?host=118.178.196.26',
    good.replace('postgresql:', 'https:'),
    'postgresql://101.34.242.103:8151/fengyu_daily_dev',
    'invalid secret connection',
  ]) assert.throws(() => validateDailyConnection(wrong));
});
