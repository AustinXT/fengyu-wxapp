const test = require('node:test');
const assert = require('node:assert/strict');
const { testDatabase } = require('./test-database');
test('数据库测试目标限制：拒绝业务库和生产，只接受本机或显式开发临时库', () => {
  const keys = ['DAILY_TEST_DATABASE_URL', 'DAILY_TEST_TEMP_DB', 'PG_CONNECTION_STRING'];
  const previous = Object.fromEntries(keys.map(key => [key, process.env[key]]));
  const name = 'daily_regression_' + 'a'.repeat(24);
  try {
    delete process.env.DAILY_TEST_DATABASE_URL;
    assert.equal(testDatabase(), undefined);
    process.env.DAILY_TEST_DATABASE_URL = 'postgres://user:pass@localhost/test';
    assert.equal(testDatabase(), process.env.DAILY_TEST_DATABASE_URL);
    for (const url of ['postgres://user:pass@101.34.242.103:8151/fengyu_daily_dev',
      `postgres://user:pass@118.178.196.26:8151/${name}`, `postgres://user:pass@101.34.242.103:8151/${name}`]) {
      process.env.DAILY_TEST_DATABASE_URL = url;
      delete process.env.DAILY_TEST_TEMP_DB;
      assert.throws(testDatabase, /只接受/);
    }
    process.env.DAILY_TEST_TEMP_DB = name;
    assert.equal(testDatabase(), process.env.DAILY_TEST_DATABASE_URL);
    process.env.DAILY_TEST_DATABASE_URL += '?options=override';
    assert.throws(testDatabase, /只接受/);
  } finally {
    for (const key of keys) previous[key] === undefined ? delete process.env[key] : process.env[key] = previous[key];
  }
});
