// pages/mgmt-dashboard — 管理层 Hub 页
// 4 个 tab（首页/排行榜/顾客/我的）在同一页面内切换，避免 wx.reLaunch 开销
// 本 ticket 仅搭骨架，实际业务内容由后续 ticket 补齐
import { canAccessManagement } from '../../utils/role'

const app = getApp<IAppOption>()

type MgmtTab = 'dashboard' | 'ranking' | 'customers' | 'profile'

Page({
  data: {
    activeTab: 'dashboard' as MgmtTab,
    canSwitchStore: false,
    staffName: '',
    phone: '',
    position: '',
    staffLevelLabel: '',
  },

  onLoad(options: { tab?: string }) {
    // 支持 deep link：?tab=ranking 进入时定位到某 tab
    const tab = options?.tab as MgmtTab | undefined
    if (tab && ['dashboard', 'ranking', 'customers', 'profile'].includes(tab)) {
      this.setData({ activeTab: tab })
    }
  },

  onShow() {
    if (!canAccessManagement()) {
      wx.reLaunch({ url: '/pages/workbench/workbench' })
      return
    }
    const { staffName, phone, position, staffLevel, availableLoginLevels } = app.globalData
    this.setData({
      canSwitchStore: (availableLoginLevels || []).includes('store'),
      staffName,
      phone,
      position,
      staffLevelLabel: staffLevel === 'headquarters' ? '总部' : staffLevel === 'market' ? '市场' : '',
    })
  },

  onTabChange(e: WechatMiniprogram.CustomEvent<{ key: MgmtTab }>) {
    const key = e.detail?.key
    if (!key || key === this.data.activeTab) return
    this.setData({ activeTab: key })
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
