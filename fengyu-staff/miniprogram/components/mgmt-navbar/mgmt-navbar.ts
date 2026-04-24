// components/mgmt-navbar — 管理层视图的底部 tab 导航
// 抛 change 事件让父页面本地 setData 切换，避免 wx.reLaunch 重建页面栈的开销
type MgmtTab = 'dashboard' | 'ranking' | 'customers' | 'profile'

Component({
  properties: {
    active: { type: String, value: 'dashboard' },
  },
  methods: {
    onTap(e: WechatMiniprogram.TouchEvent) {
      const key = (e.currentTarget.dataset.key || 'dashboard') as MgmtTab
      if (key === this.data.active) return
      this.triggerEvent('change', { key })
    },
  },
})
