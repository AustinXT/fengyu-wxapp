


Component({
  properties: {
    state: { type: String, value: 'content' }, 
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
