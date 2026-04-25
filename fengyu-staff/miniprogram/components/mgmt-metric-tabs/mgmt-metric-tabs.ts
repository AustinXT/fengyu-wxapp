// components/mgmt-metric-tabs — 指标切换按钮组（3 / 4 列网格）
// 替代 dashboard 排行 .ranking-metrics（员工 + 门店 排行各一份）
Component({
  properties: {
    options: { type: Array, value: [] }, // [{ label, value }]
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
