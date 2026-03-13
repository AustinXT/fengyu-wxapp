/**
 * wx-server-sdk mock — 云函数仅用 init() + getWXContext() + DYNAMIC_CURRENT_ENV
 * 注意：vi 由 vitest globals 注入，不能 require('vitest')
 */
module.exports = {
  init: vi.fn(),
  getWXContext: vi.fn(() => ({
    OPENID: 'test-openid-001',
    APPID: 'wx811eb4ded3dfba3f',
    UNIONID: undefined,
  })),
  DYNAMIC_CURRENT_ENV: 'test-env',
}
