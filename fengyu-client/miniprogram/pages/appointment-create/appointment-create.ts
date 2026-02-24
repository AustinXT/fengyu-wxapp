// pages/appointment-create/appointment-create.ts
import Toast from '@vant/weapp/toast/toast';

const app = getApp<IAppOption>();

const TIME_SLOTS = ['上午 09:00-11:00', '上午 11:00-13:00', '下午 13:00-15:00', '下午 15:00-17:00', '下午 17:00-19:00'];

Page({
  data: {
    // 可预约项目列表
    appointableItems: [] as any[],
    selectedItemFlowNo: '',
    selectedItemOrderNo: '',

    // 时间
    appointmentDate: '',
    appointmentTimeSlot: '',
    minDate: Date.now(),
    maxDate: Date.now() + 90 * 24 * 60 * 60 * 1000,

    // 美容师
    staffList: [] as any[],
    defaultStaffName: '',
    selectedStaffWfId: '',
    selectedStaffName: '',

    notes: '',

    // UI 状态
    showCalendar: false,
    showTimePicker: false,
    showStaffPopup: false,
    timeSlots: TIME_SLOTS,
    submitting: false,
  },

  onLoad(options) {
    const { orderNo } = options as { orderNo?: string };
    this.loadAppointableItems(orderNo);
    this.loadStaffList();
    this.loadDefaultStaff();
  },

  async loadAppointableItems(filterOrderNo?: string) {
    try {
      const res = await wx.cloud.callFunction({
        name: 'getAppointableItems',
        data: { orderNo: filterOrderNo },
      }) as any;
      this.setData({ appointableItems: res.result?.data || [] });
    } catch {
      Toast.fail('加载可预约项目失败');
    }
  },

  async loadStaffList() {
    try {
      const res = await wx.cloud.callFunction({
        name: 'getStaffList',
        data: { storeName: app.globalData.boundStoreName },
      }) as any;
      this.setData({ staffList: res.result?.data || [] });
    } catch {
      // 静默失败，美容师列表不影响预约
    }
  },

  async loadDefaultStaff() {
    try {
      const res = await wx.cloud.callFunction({ name: 'getMyDefaultStaff' }) as any;
      const staff = res.result?.data;
      if (staff) {
        this.setData({
          defaultStaffName: staff.name,
          selectedStaffWfId: staff.staff_wf_id,
          selectedStaffName: staff.name,
        });
      }
    } catch {
      // 静默失败
    }
  },

  onSelectItem(e: WechatMiniprogram.TouchEvent) {
    const item = e.currentTarget.dataset.item as any;
    this.setData({
      selectedItemFlowNo: item.item_flow_no,
      selectedItemOrderNo: item.order_no,
    });
  },

  onShowDatePicker() {
    this.setData({ showCalendar: true });
  },

  onCloseCalendar() {
    this.setData({ showCalendar: false });
  },

  onDateConfirm(e: WechatMiniprogram.CustomEvent<Date>) {
    const d = e.detail;
    const fmt = `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
    this.setData({ appointmentDate: fmt, showCalendar: false });
  },

  onShowTimePicker() {
    this.setData({ showTimePicker: true });
  },

  onCloseTimePicker() {
    this.setData({ showTimePicker: false });
  },

  onTimeConfirm(e: WechatMiniprogram.CustomEvent<{ value: string }>) {
    this.setData({ appointmentTimeSlot: e.detail.value, showTimePicker: false });
  },

  onShowStaffPopup() {
    this.setData({ showStaffPopup: true });
  },

  onCloseStaffPopup() {
    this.setData({ showStaffPopup: false });
  },

  onStaffSelect(e: WechatMiniprogram.TouchEvent) {
    const { wfId, name } = e.currentTarget.dataset as { wfId: string; name: string };
    this.setData({ selectedStaffWfId: wfId, selectedStaffName: name, showStaffPopup: false });
  },

  onGoOrders() {
    wx.switchTab({ url: '/pages/orders/orders' });
  },

  async onSubmit() {
    const { selectedItemFlowNo, appointmentDate, appointmentTimeSlot, selectedStaffWfId, notes } = this.data;
    if (!selectedItemFlowNo || !appointmentDate || !appointmentTimeSlot) {
      Toast('请填写完整预约信息');
      return;
    }
    if (this.data.submitting) return;
    this.setData({ submitting: true });
    try {
      await wx.cloud.callFunction({
        name: 'createAppointment',
        data: {
          itemFlowNo: selectedItemFlowNo,
          appointmentTime: `${appointmentDate} ${appointmentTimeSlot}`,
          staffWfId: selectedStaffWfId || null,
          notes: notes.trim() || null,
        },
      });
      Toast.success('预约申请已提交');
      setTimeout(() => {
        wx.switchTab({ url: '/pages/appointment/appointment' });
      }, 1500);
    } catch (err: any) {
      Toast.fail(err?.errMsg || '提交失败，请重试');
    } finally {
      this.setData({ submitting: false });
    }
  },

  onShareAppMessage() {
    return { title: '凤御预约', path: '/pages/appointment/appointment' };
  },
});
