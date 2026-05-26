// components/mgmt-period-picker — 时间段筛选 chip（边框 + 红填充式）
// 替代 dashboard 排行 .ranking-periods / product-cycle .pc-filter / traffic-stats .tf-filter
Component({
  properties: {
    options: { type: Array, value: [] }, // [{ label, value }]
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
