// pages/mgmt-profile — 管理层"我的"（占位，含基础信息 + 退出登录）
import { canAccessManagement } from '../../utils/role'

const app = getApp<IAppOption>()

Page({
  data: {
    staffName: '',
    phone: '',
    position: '',
    staffLevelLabel: '',
    canSwitchStore: false,
  },

  onShow() {
    if (!canAccessManagement()) {
      wx.reLaunch({ url: '/pages/workbench/workbench' })
      return
    }
    const { staffName, phone, position, staffLevel, availableLoginLevels } = app.globalData
    this.setData({
      staffName,
      phone,
      position,
      staffLevelLabel: staffLevel === 'headquarters' ? '总部' : staffLevel === 'market' ? '市场' : '',
      canSwitchStore: (availableLoginLevels || []).includes('store'),
    })
  },

  onSwitchToStore() {
    app.setLoginLevel('store')
    wx.reLaunch({ url: '/pages/workbench/workbench' })
  },

  onLogout() {
    wx.showModal({
      title: '退出登录',
      content: '确认退出当前账号？',
      success: (res) => {
        if (res.confirm) {
          app.resetStaffInfo()
          wx.reLaunch({ url: '/pages/login/login' })
        }
      },
    })
  },
})
