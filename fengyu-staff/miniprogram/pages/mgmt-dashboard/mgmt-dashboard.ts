// pages/mgmt-dashboard — 管理层首页（数据中心）
// 本 ticket 仅搭骨架，实际业务内容由后续 ticket 补齐
import { canAccessManagement } from '../../utils/role'

Page({
  data: {
    canSwitchStore: false,
  },
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
