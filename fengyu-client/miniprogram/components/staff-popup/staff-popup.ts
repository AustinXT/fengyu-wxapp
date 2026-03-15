// components/staff-popup/staff-popup.ts
Component({
  properties: {
    show: { type: Boolean, value: false },
    staffList: { type: Array, value: [] },
    selectedId: { type: String, value: '' },
    loading: { type: Boolean, value: false },
  },

  methods: {
    onSelect(e: WechatMiniprogram.TouchEvent) {
      const { wfId, name } = e.currentTarget.dataset as { wfId: string; name: string };
      this.triggerEvent('select', { wfId, name });
    },

    onClose() {
      this.triggerEvent('close');
    },
  },
});
