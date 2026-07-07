

Component({
  properties: {
    options: { type: Array, value: [] }, 
    value: { type: String, value: '' },
    columns: { type: Number, value: 3 },
  },
  methods: {
    onSelect(e: WechatMiniprogram.TouchEvent) {
      const v = (e.currentTarget.dataset.value || '') as string
      if (v === this.data.value) return
      this.triggerEvent('change', { value: v })
    },
  },
})
