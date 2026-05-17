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
 * uploadFile 是 stub —— auth.uploadAvatar / staff.uploadAvatar 测试不真实上传 COS，
 * 而是返回 fileID 字符串嵌入 envId，便于断言"跨 env upload 写到了 client envId 域"。
 *
 * Cloud 构造器：staff.uploadAvatar 用 `new cloud.Cloud({resourceEnv, identityless})`
 * 跨 env 上传到 client env。mock 把 resourceEnv 嵌入返回的 fileID 中，
 * 测试可断言 fileID.startsWith(`cloud://${CLIENT_ENV_ID}.`) 即"真的写到了 client env"。
 */

function makeUploadFile(envId) {
  return async function uploadFile({ cloudPath /*, fileContent */ }) {
    const fileID = `cloud://${envId || 'e2e-mock.test'}.bucket/${cloudPath}`
    return { fileID, statusCode: 200, errMsg: 'uploadFile:ok' }
  }
}

class Cloud {
  constructor(opts = {}) {
    this._resourceEnv = opts.resourceEnv || 'test-env'
    this._identityless = !!opts.identityless
  }
  async init() {
    // 真实 wx-server-sdk 的 Cloud#init 是 async；保持同形态
    return undefined
  }
  uploadFile(args) {
    return makeUploadFile(this._resourceEnv)(args)
  }
  getWXContext() {
    return {
      OPENID: globalThis.__e2e_current_openid__ || '__e2e_mock_openid__',
      APPID: 'wxe3f5d9ee6a94d22d',
      UNIONID: undefined,
    }
  }
}

module.exports = {
  init: function noop() {},
  DYNAMIC_CURRENT_ENV: 'test-env',
  Cloud,
  getWXContext: function () {
    return {
      OPENID: globalThis.__e2e_current_openid__ || '__e2e_mock_openid__',
      APPID: 'wxe3f5d9ee6a94d22d',
      UNIONID: undefined,
    }
  },
  // 顶层 uploadFile 默认走"当前 env"（占位 e2e-mock.test）
  uploadFile: makeUploadFile(null),
}
