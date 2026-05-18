/**
 * DevTools 控制台代码片段：切换测试员工身份
 *
 * 用途：在微信开发者工具的"调试器 → Console"里粘贴执行，
 *      把当前小程序登录身份切换到任意员工，便于测试不同角色 / 权限场景。
 *
 * 前置条件：
 *   1. staffApi 远端云函数已部署最新版本（含 routes/auth.js 的 ALLOW_TEST_OPENID 门控分支）
 *   2. staffApi 云函数环境变量 ALLOW_TEST_OPENID=true（参考 memory: allow-test-openid-persistent）
 *   3. miniprogram/utils/cloud.ts 含 __devTestOpenid 自动注入逻辑
 *
 * 工作原理：
 *   - 每个测试员工分配一个稳定的合成 openid（建议 `dev-{名字}` 命名）
 *   - bindPhone 把该 openid 写到对应员工 phone 行 → staff_wechat_users.openid = 'dev-xxx'
 *   - localStorage `__devTestOpenid` 被 cloud.ts 在每次 callStaffApi 时自动注入到 payload._testOpenid
 *   - 中间件 auth.js 在 ALLOW_TEST_OPENID=true 时优先采用 _testOpenid 作为 OPENID
 *
 * 上线前清理：
 *   UPDATE staff_wechat_users SET openid = NULL WHERE openid LIKE 'dev-%';
 *   并把云函数 ALLOW_TEST_OPENID 删除，此机制自动失效。
 */

// ============================================================
// 1. 首次绑定（每个测试员工跑一次，绑完入库永久生效）
// ============================================================
// 把"张三"映射到 dev-zhang3 这个合成 openid
wx.cloud.callFunction({
  name: 'staffApi',
  data: {
    action: 'auth.bindPhone',
    payload: { _testOpenid: 'dev-zhang3', phoneNumber: '13800138001' }
  }
}).then(r => console.log('bind:', r.result))


// ============================================================
// 2. 切换身份（日常使用）
// ============================================================
// ⚠️ 顺序必须是：先 reset（含 clearStorageSync）→ 再写 key → 再 reLaunch
getApp().resetStaffInfo()
wx.setStorageSync('__devTestOpenid', 'dev-zhang3')
wx.reLaunch({ url: '/pages/login/login' })


// ============================================================
// 3. 退出测试模式（回到正常微信登录）
// ============================================================
// resetStaffInfo 内部 wx.clearStorageSync 会一并清掉 __devTestOpenid
getApp().resetStaffInfo()
wx.reLaunch({ url: '/pages/login/login' })


// ============================================================
// 4. 批量绑定示例（一次性把几个测试员工建好）
// ============================================================
const testEmployees = [
  { openid: 'dev-store-mgr',  phone: '13800138001' },  // 店长
  { openid: 'dev-cashier',    phone: '13800138002' },  // 收银
  { openid: 'dev-beautician', phone: '13800138003' },  // 美容师
  { openid: 'dev-finance',    phone: '13800138004' },  // 财务
  { openid: 'dev-headquarter',phone: '13800138005' },  // 总部
]
;(async () => {
  for (const { openid, phone } of testEmployees) {
    const r = await wx.cloud.callFunction({
      name: 'staffApi',
      data: {
        action: 'auth.bindPhone',
        payload: { _testOpenid: openid, phoneNumber: phone }
      }
    })
    console.log(`${openid} <- ${phone}:`, r.result?.code === 0 ? 'OK' : r.result?.message)
  }
})()
