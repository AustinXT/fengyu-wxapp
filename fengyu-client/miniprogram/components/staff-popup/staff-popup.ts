
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
      const { wfId, name, onLeave } = e.currentTarget.dataset as { wfId: string; name: string; onLeave?: boolean };
      
      if (onLeave) {
        wx.showToast({ title: '该美容师该时段休假中', icon: 'none' });
        return;
      }
      this.triggerEvent('select', { wfId, name });
    },

    onClose() {
      this.triggerEvent('close');
    },
  },
});
