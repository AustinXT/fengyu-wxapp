/**
 * 本地 wx-server-sdk mock 实体文件
 *
 * 作为 require.cache 替身 — invoke.mjs 在云函数加载前将本文件
 * 注入到模块解析路径，让所有 require('wx-server-sdk') 都得到此 mock。
 *
 * OPENID 解析优先级：
 * 1. globalThis.__e2e_current_openid__（由 client invoke wrapper 在每次调用前 set）
 *    用于覆盖那些直接读 cloud.getWXContext() 的路由（如 auth.login / bindStore / bindPhone）
 * 2. 占位值 '__e2e_mock_openid__'（兼容旧 staffApi smoke 路径——staffApi 路由全部走
 *    auth 中间件 + ctx.auth.userId，OPENID 占位即可，由 payload._testOpenid 在中间件层覆盖）
 *
 * uploadFile 是 stub —— auth.uploadAvatar 测试不真实上传 COS，返回构造 fileID。
 */
module.exports = {
  init: function noop() {},
  DYNAMIC_CURRENT_ENV: 'test-env',
  getWXContext: function () {
    return {
      OPENID: globalThis.__e2e_current_openid__ || '__e2e_mock_openid__',
      APPID: 'wxe3f5d9ee6a94d22d',
      UNIONID: undefined,
    }
  },
  uploadFile: async function ({ cloudPath /*, fileContent */ }) {
    // 不真上传，返回 mock fileID 让业务 SQL 继续走通
    const fileID = `cloud://e2e-mock.test/${cloudPath}`
    return { fileID, statusCode: 200, errMsg: 'uploadFile:ok' }
  },
}
