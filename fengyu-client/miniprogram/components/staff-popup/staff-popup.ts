
Component({
  
  
  
  options: {
    styleIsolation: 'apply-shared',
  },

  properties: {
    show: { type: Boolean, value: false },
    staffList: { type: Array, value: [] },
    selectedId: { type: String, value: '' },
    loading: { type: Boolean, value: false },
  },

  methods: {
    onSelect(e: WechatMiniprogram.TouchEvent) {
      const { wfId, name, onLeave, booked } = e.currentTarget.dataset as { wfId: string; name: string; onLeave?: boolean; booked?: boolean };
      
      if (onLeave) {
        wx.showToast({ title: '该美容师该时段休息中', icon: 'none' });
        return;
      }
      if (booked) {
        wx.showToast({ title: '该美容师该时段已约满', icon: 'none' });
        return;
      }
      this.triggerEvent('select', { wfId, name });
    },

    onClose() {
      this.triggerEvent('close');
    },
  },
});
