/**
 * 本地 wx-server-sdk mock 实体文件
 *
 * 作为 require.cache 替身 — invoke.mjs 在云函数加载前将本文件
 * 注入到模块解析路径，让所有 require('wx-server-sdk') 都得到此 mock。
 *
 * 不能在测试中调整 OPENID：云函数 auth 中间件已支持
 * payload._testOpenid（仅在 ALLOW_TEST_OPENID=true 时生效），
 * 所以 mock 的 OPENID 字段始终返回固定无效值，由 payload._testOpenid 覆盖。
 */
module.exports = {
  init: function noop() {},
  DYNAMIC_CURRENT_ENV: 'test-env',
  getWXContext: function () {
    return {
      OPENID: '__e2e_mock_openid__', // 占位，业务永远不应使用；测试由 _testOpenid 覆盖
      APPID: 'wxe3f5d9ee6a94d22d',
      UNIONID: undefined,
    }
  },
}
