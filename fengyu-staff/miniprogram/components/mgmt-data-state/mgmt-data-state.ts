// components/mgmt-data-state — 整页/整段三态壳（loading / empty / error / content）
// 显式状态机：调用方传 state，组件不读业务数据；错误态带重试按钮
// 仅用于整页或整段数据，分页 footer 的小 loading 仍然手写 <van-loading />
Component({
  properties: {
    state: { type: String, value: 'content' }, // 'loading' | 'empty' | 'error' | 'content'
    loadingText: { type: String, value: '' },
    emptyText: { type: String, value: '暂无数据' },
    errorText: { type: String, value: '加载失败' },
    retryText: { type: String, value: '重试' },
  },
  methods: {
    onRetry() {
      this.triggerEvent('retry')
    },
  },
})
