/**
 * 冒烟测试矩阵 — invokeFunction 集成验证
 * 使用 _testOpenid 对已部署云函数逐 action 调用验证
 *
 * 默认跳过，CI 环境手动启用：SMOKE=1 npx vitest run __tests__/smoke.test.js
 */

const shouldRun = process.env.SMOKE === '1'

const describeFn = shouldRun ? describe : describe.skip

describeFn('clientApi 冒烟测试', () => {
  // 需要真实环境才能运行
  let wx

  beforeAll(async () => {
    // 动态 import wx-server-sdk（不 mock）
    wx = require('wx-server-sdk')
    wx.init({ env: 'cloud1-3gpht4b01ff88838' })
  })

  const _testOpenid = 'smoke-test-openid'

  async function invoke(action, payload = {}) {
    const res = await wx.cloud.callFunction({
      name: 'clientApi',
      data: {
        action,
        payload: { ...payload, _testOpenid },
      },
    })
    return res.result
  }

  // ---- auth ----
  test('auth.login', async () => {
    const res = await invoke('auth.login')
    expect(res.code).toBe(0)
    expect(res.data).toHaveProperty('userId')
  })

  // ---- store ----
  test('store.list', async () => {
    const res = await invoke('store.list')
    expect(res.code).toBe(0)
    expect(res.data).toHaveProperty('stores')
  })

  // ---- product ----
  test('product.categories', async () => {
    const res = await invoke('product.categories')
    expect(res.code).toBe(0)
    expect(res.data).toHaveProperty('categories')
  })

  test('product.shopInit', async () => {
    const res = await invoke('product.shopInit')
    expect(res.code).toBe(0)
    expect(res.data).toHaveProperty('categories')
    expect(res.data).toHaveProperty('spuList')
  })

  test('product.hotList', async () => {
    const res = await invoke('product.hotList', { limit: 3 })
    expect(res.code).toBe(0)
    expect(res.data).toHaveProperty('spuList')
  })

  // ---- staff ----
  test('staff.list 缺少 storeId → -400', async () => {
    const res = await invoke('staff.list')
    expect(res.code).toBe(-400)
  })

  // ---- order ----
  test('order.list', async () => {
    const res = await invoke('order.list')
    expect(res.code).toBe(0)
    expect(res.data).toHaveProperty('orders')
  })

  // ---- appointment ----
  test('appointment.list', async () => {
    const res = await invoke('appointment.list')
    expect(res.code).toBe(0)
    expect(res.data).toHaveProperty('appointments')
  })

  // ---- coupon ----
  test('coupon.list → 可能 -403 (PHONE_REQUIRED)', async () => {
    const res = await invoke('coupon.list')
    // 冒烟用户可能没手机号
    expect([-403, 0]).toContain(res.code)
  })
})
