/**
 * DevTools 控制台一行命令：切换/退出测试员工身份
 *
 * 切换（每次调用都是幂等的 bind + 切身份 + 自动 reLaunch）：
 *   getApp().switchTestUser('dev-zhang3', '13800138001')
 *                            ^ 任意 dev openid    ^ 真实员工 phone
 *
 * 退出测试模式（回到真实微信登录）：
 *   getApp().switchTestUser(null)
 *
 * 工作机制：
 *   - 函数内部依次执行：后端 auth.bindPhone（把 dev openid 写到该 phone 员工档案行）
 *     → resetStaffInfo（清 globalData + localStorage） → setStorageSync('__devTestOpenid', openid)
 *     → wx.reLaunch 到登录页 → onLaunch 的 syncLoginState 自动注入 _testOpenid → 拿到 dev 身份 → 跳 tabBar
 *   - 切换不同员工：换 openid + phone 再调一次即可
 *
 * 前置条件（已就绪）：
 *   - staffApi 远端 ALLOW_TEST_OPENID=true
 *   - staffApi 远端已部署支持 _testOpenid 的 routes/auth.js（2026-05-18 已部署）
 *
 * 上线前清理：
 *   UPDATE staff_wechat_users SET openid = NULL WHERE openid LIKE 'dev-%';
 *   并把云函数 ALLOW_TEST_OPENID 删除，此机制自动失效。
 */
