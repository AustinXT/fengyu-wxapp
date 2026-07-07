

Component({
  properties: {
    pageTitle: { type: String, value: '' },
    subtitle: { type: String, value: '功能建设中，敬请期待' },
    icon: { type: String, value: 'gem-o' },
    showSwitchToStore: { type: Boolean, value: false },
  },
  methods: {
    onSwitchToStore() {
      const app = getApp<IAppOption>()
      app.setLoginLevel('store')
      wx.reLaunch({ url: '/pages/workbench/workbench' })
    },
  },
})
