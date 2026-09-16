interface StatusOption {
  text: string;
  value: string;
}

Component({
  properties: {
    value: {
      type: String,
      value: '',
    },
    placeholder: {
      type: String,
      value: '搜索顾客姓名或手机号',
    },
    status: {
      type: String,
      value: '',
    },
    statusOptions: {
      type: Array,
      value: [] as StatusOption[],
    },
    startDate: {
      type: String,
      value: '',
    },
    endDate: {
      type: String,
      value: '',
    },
    /**
     * 日期筛选口径说明（可选）。为空则整行不渲染。
     * 各页面口径不同（订单列表/营业额分配 = 业绩归属日期，服务提成 = 服务日期，
     * 预约 = 预约时间），故由调用方显式传入，组件不设默认文案。
     */
    dateHint: {
      type: String,
      value: '',
    },
  },

  methods: {
    onKeywordChange(e: WechatMiniprogram.CustomEvent) {
      this.triggerEvent('keyword-change', e.detail);
    },

    onSearch() {
      this.triggerEvent('search');
    },

    onSearchClear() {
      this.triggerEvent('search-clear');
    },

    onStatusChange(e: WechatMiniprogram.CustomEvent) {
      this.triggerEvent('status-change', e.detail);
    },

    onStartDateChange(e: WechatMiniprogram.PickerChange) {
      this.triggerEvent('start-date-change', { value: e.detail.value });
    },

    onEndDateChange(e: WechatMiniprogram.PickerChange) {
      this.triggerEvent('end-date-change', { value: e.detail.value });
    },

    onClearDates() {
      this.triggerEvent('clear-dates');
    },
  },
});
