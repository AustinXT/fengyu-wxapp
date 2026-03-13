/**
 * wx-server-sdk mock — 云函数仅用 init() + getWXContext() + DYNAMIC_CURRENT_ENV
 */
module.exports = {
  init: jest.fn(),
  getWXContext: jest.fn(() => ({
    OPENID: 'test-openid-001',
    APPID: 'wxe3f5d9ee6a94d22d',
    UNIONID: undefined,
  })),
  DYNAMIC_CURRENT_ENV: 'test-env',
}
