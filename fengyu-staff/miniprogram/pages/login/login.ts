// pages/login/login.ts — 登录页
import { bindPhone } from '../../utils/auth'

const app = getApp<IAppOption>()

const ROUTE_STORE_TAB = '/pages/workbench/workbench'
const ROUTE_MANAGEMENT_HOME = '/pages/mgmt-dashboard/mgmt-dashboard'

Page({
  data: {
    checking: true,
    binding: false,
    errorMsg: '',
    availableLoginLevels: [] as LoginLevel[],
    loginLevel: 'store' as LoginLevel,
  },

  onLoad() {
    // 快速路径：缓存命中
    if (app.globalData.staffWfId) {
      this.jumpByLoginLevel()
      return
    }
    // 慢路径：等待 auth.login 完成
    this.checkAuth()
  },

  async checkAuth() {
    await app._loginReady
    if (app.globalData.staffWfId) {
      this.refreshLevelData()
      this.jumpByLoginLevel()
    } else {
      this.setData({ checking: false })
    }
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
      // 根据 available 与用户选择锁定 loginLevel
      const levels = app.globalData.availableLoginLevels || []
      let chosen: LoginLevel = this.data.loginLevel
      if (!levels.includes(chosen)) chosen = levels[0] || 'store'
      app.setLoginLevel(chosen)
      this.jumpByLoginLevel()
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : '绑定失败';
      this.setData({ binding: false, errorMsg: msg })
    }
  },
})
