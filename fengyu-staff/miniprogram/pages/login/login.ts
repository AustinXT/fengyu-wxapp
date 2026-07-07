



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
        
        app.setLoginLevel(levels[0])
        this.jumpByLoginLevel()
        return
      }
      
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
