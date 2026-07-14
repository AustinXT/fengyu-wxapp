// components/staff-popup/staff-popup.ts
Component({
  // 让 app.wxss 中 .staff-popup / .staff-list / .staff-item / .staff-avatar / .staff-avatar-img
  // 等全局样式可以渗入本组件。默认 isolated 会屏蔽掉这些 selector，导致 <image> 用 <image>
  // 默认 320×240 尺寸撑满列宽（screenshot 3 bug）；本组件样式也不会泄露出去。
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
      // 休假/已约满员工不可选（仅预约流程会传 onLeave/booked；结算页不计算该字段，照常可选）
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
