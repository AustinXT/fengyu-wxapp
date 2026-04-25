// components/mgmt-stat-card — 管理层统计卡（数字 + 标签）
// 替代 customer-list 6 张 stat-card / customer-detail 头部 stat-item / traffic-stats tf-cell & tf-avg-ticket
Component({
  options: {
    multipleSlots: false,
  },
  properties: {
    count: { type: null, value: '' },
    label: { type: String, value: '' },
    size: { type: String, value: 'lg' }, // 'lg' | 'md'
    variant: { type: String, value: 'default' }, // 'default'|'primary'|'success'|'warning'|'error'|'info'|'muted'
    selected: { type: Boolean, value: false },
    unit: { type: String, value: '' },
    countColor: { type: String, value: '' }, // 透传覆写（特殊鲜亮色场景用）
  },
  methods: {
    onTap() {
      this.triggerEvent('tap')
    },
  },
})
