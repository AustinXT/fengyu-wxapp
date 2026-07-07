

type MgmtTab = 'dashboard' | 'storeRanking' | 'staffRanking' | 'profile'

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
