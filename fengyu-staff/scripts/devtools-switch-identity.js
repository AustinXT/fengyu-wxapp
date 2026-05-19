/**
 * DevTools 控制台一行命令：切换/退出测试员工身份
 *
 * 切换（传入真实员工手机号即可）：
 *   getApp().switchTestUser('15979157162')
 *
 * 退出测试模式（回到真实微信登录）：
 *   getApp().switchTestUser(null)
 *
 * 工作机制：
 *   - 内部生成合成 openid `dev-${phone}`，与该 phone 一一对应
 *   - 自动做：bindPhone（dev openid 写到该员工档案行） → resetStaffInfo（清缓存）
 *     → setStorageSync('__devTestOpenid', openid) → wx.reLaunch 登录页
 *   - onLaunch 的 syncLoginState 自动注入 _testOpenid → 拿到该员工身份 → 跳 tabBar
 *   - 切换到另一员工只需换 phone 再调一次
 *
 * 前置条件（已就绪）：
 *   - staffApi 远端 ALLOW_TEST_OPENID=true
 *   - staffApi 远端已部署支持 _testOpenid + 测试模式换绑放宽（2026-05-18）
 *
 * 上线前清理：
 *   UPDATE staff_wechat_users SET openid = NULL WHERE openid LIKE 'dev-%';
 *   并把云函数 ALLOW_TEST_OPENID 删除，此机制自动失效。
 */
