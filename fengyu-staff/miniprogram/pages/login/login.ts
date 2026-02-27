// pages/login/login.ts — 登录页
import { bindPhone } from '../../utils/auth'

const app = getApp<IAppOption>()

Page({
  data: {
    checking: true,
    binding: false,
    errorMsg: '',
  },

  onLoad() {
    // 快速路径：缓存命中
    if (app.globalData.staffWfId) {
      wx.switchTab({ url: '/pages/workbench/workbench' })
      return
    }
    // 慢路径：等待 auth.login 完成
    this.checkAuth()
  },

  async checkAuth() {
    await app._loginReady
    if (app.globalData.staffWfId) {
      wx.switchTab({ url: '/pages/workbench/workbench' })
    } else {
      this.setData({ checking: false })
    }
  },

  async onGetPhoneNumber(e: WechatMiniprogram.CustomEvent) {
    const { errMsg, cloudID } = e.detail || {}
    if (errMsg && errMsg.indexOf('fail') !== -1) {
      // 用户拒绝或无权限
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
      if (app.globalData.staffWfId) {
        wx.switchTab({ url: '/pages/workbench/workbench' })
      } else {
        this.setData({ binding: false, errorMsg: '手机号未关联员工档案，请联系管理员' })
      }
    } catch (err: any) {
      this.setData({ binding: false, errorMsg: err.message || '绑定失败' })
    }
  },
})
