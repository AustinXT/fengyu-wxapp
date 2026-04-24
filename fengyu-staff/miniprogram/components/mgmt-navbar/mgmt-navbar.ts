// components/mgmt-navbar — 管理层视图的底部 tab 导航
// 由于小程序 tabBar.list 上限 5 项，管理层 4 页未放入原生 tabBar，改用此组件模拟。
// 使用方式：在 mgmt-* 页面底部固定引入该组件并传入 active 项。
type MgmtTab = 'dashboard' | 'ranking' | 'customers' | 'profile'

const ROUTES: Record<MgmtTab, string> = {
  dashboard: '/pages/mgmt-dashboard/mgmt-dashboard',
  ranking: '/pages/mgmt-ranking/mgmt-ranking',
  customers: '/pages/mgmt-customers/mgmt-customers',
  profile: '/pages/mgmt-profile/mgmt-profile',
}

Component({
  properties: {
    active: { type: String, value: 'dashboard' },
  },
  methods: {
    onTap(e: WechatMiniprogram.TouchEvent) {
      const key = (e.currentTarget.dataset.key || 'dashboard') as MgmtTab
      if (key === this.data.active) return
      const url = ROUTES[key]
      if (url) wx.reLaunch({ url })
    },
  },
})
