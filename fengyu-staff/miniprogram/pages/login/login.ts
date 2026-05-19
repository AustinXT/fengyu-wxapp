// pages/login/login.ts — 登录页
// 两阶段状态机：
//   initial  → 显示「授权手机号登录」按钮
//   authed   → 已拿到 availableLoginLevels（2 项时），显示 radio + 「登录」按钮
import { bindPhone } from '../../utils/auth'

const app = getApp<IAppOption>()

const ROUTE_STORE_TAB = '/pages/workbench/workbench'
const ROUTE_MANAGEMENT_HOME = '/pages/mgmt-dashboard/mgmt-dashboard'

Page({
  data: {
    checking: true,
    binding: false,
    errorMsg: '',
    phase: 'initial' as 'initial' | 'authed',
    availableLoginLevels: [] as LoginLevel[],
    loginLevel: 'store' as LoginLevel,
  },

  onLoad() {
    this.checkAuth()
  },

  async checkAuth() {
    // 即使缓存里有 staffWfId 也要等 syncLoginState 用最新服务端结果覆盖；
    // 否则 storage 残留 loginLevel='management' 的用户会被甩进未授权的管理层页。
    await app._loginReady
    if (app.globalData.staffWfId) {
      this.jumpByLoginLevel()
      return
    }
    this.setData({ checking: false, phase: 'initial' })
  },

  refreshLevelData() {
    const levels = app.globalData.availableLoginLevels || []
    const existing = app.globalData.loginLevel
    const level: LoginLevel = existing && levels.includes(existing) ? existing : (levels[0] || 'store')
    this.setData({
      availableLoginLevels: levels,
      loginLevel: level,
    })
  },

  onLoginLevelChange(e: WechatMiniprogram.CustomEvent) {
    const v = e.detail as unknown as LoginLevel
    this.setData({ loginLevel: v })
  },

  jumpByLoginLevel() {
    const level = app.globalData.loginLevel || 'store'
    // 管理层 4 页未放入原生 tabBar（小程序 list 上限 5 项），用 reLaunch 切换页面栈
    if (level === 'management') {
      wx.reLaunch({ url: ROUTE_MANAGEMENT_HOME })
    } else {
      wx.switchTab({ url: ROUTE_STORE_TAB })
    }
  },

  async onGetPhoneNumber(e: WechatMiniprogram.CustomEvent) {
    const { errMsg, cloudID } = e.detail || {}
    if (errMsg && errMsg.indexOf('fail') !== -1) {
      const msg = errMsg.indexOf('no permission') !== -1
        ? '小程序暂未开通手机号权限，请联系管理员'
        : '需要授权手机号才能登录'
      this.setData({ errorMsg: msg })
      return
    }
    if (!cloudID) return
    this.setData({ binding: true, errorMsg: '' })
    try {
      await bindPhone(cloudID)
      if (!app.globalData.staffWfId) {
        this.setData({ binding: false, errorMsg: '手机号未关联员工档案，请联系管理员' })
        return
      }
      const levels = app.globalData.availableLoginLevels || []
      if (levels.length === 0) {
        this.setData({ binding: false, errorMsg: '员工档案未配置权限，请联系管理员' })
        return
      }
      if (levels.length === 1) {
        // 唯一视图权限：直接进入，不显示 radio
        app.setLoginLevel(levels[0])
        this.jumpByLoginLevel()
        return
      }
      // 两种视图权限：进入 authed 阶段让用户手动选择
      this.refreshLevelData()
      this.setData({ phase: 'authed', binding: false })
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : '绑定失败'
      this.setData({ binding: false, errorMsg: msg })
    }
  },

  onEnterByLevel() {
    const levels = app.globalData.availableLoginLevels || []
    let chosen: LoginLevel = this.data.loginLevel
    if (!levels.includes(chosen)) chosen = levels[0] || 'store'
    app.setLoginLevel(chosen)
    this.jumpByLoginLevel()
  },
})
