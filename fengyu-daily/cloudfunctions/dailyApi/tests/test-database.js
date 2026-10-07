// 默认仅接受本机独立库；远程临时库只能由 test-daily-dev.mjs 显式启用。
function testDatabase() {
  const raw = process.env.DAILY_TEST_DATABASE_URL;
  if (!raw) return undefined;
  const url = new URL(raw);
  const local = ['localhost', '127.0.0.1'].includes(url.hostname) && url.pathname === '/test';
  const name = url.pathname.slice(1);
  const temporary = url.hostname === '101.34.242.103' && url.port === '8151' &&
    /^daily_regression_[a-f0-9]{24}$/.test(name) && process.env.DAILY_TEST_TEMP_DB === name;
  if (!['postgres:', 'postgresql:'].includes(url.protocol) || url.search || (!local && !temporary))
    throw Error('数据库测试只接受 localhost/test 或专用日报开发临时库');
  process.env.PG_CONNECTION_STRING = raw;
  return raw;
}
module.exports = { testDatabase };
