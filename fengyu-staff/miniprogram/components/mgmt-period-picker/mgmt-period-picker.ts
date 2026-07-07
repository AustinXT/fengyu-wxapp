

Component({
  properties: {
    options: { type: Array, value: [] }, 
    value: { type: String, value: '' },
  },
  methods: {
    onSelect(e: WechatMiniprogram.TouchEvent) {
      const v = (e.currentTarget.dataset.value || '') as string
      if (v === this.data.value) return
      this.triggerEvent('change', { value: v })
    },
  },
})
