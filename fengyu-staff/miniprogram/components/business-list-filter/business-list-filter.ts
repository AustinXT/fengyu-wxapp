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
