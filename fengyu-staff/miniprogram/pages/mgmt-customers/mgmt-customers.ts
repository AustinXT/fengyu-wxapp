// pages/mgmt-customers — 管理层顾客视图（占位）
import { canAccessManagement } from '../../utils/role'

Page({
  data: { canSwitchStore: false },
  onShow() {
    const app = getApp<IAppOption>()
    if (!canAccessManagement()) {
      wx.reLaunch({ url: '/pages/workbench/workbench' })
      return
    }
    this.setData({
      canSwitchStore: (app.globalData.availableLoginLevels || []).includes('store'),
    })
  },
})
