// pages/appointment-create/appointment-create.ts
import Toast from '@vant/weapp/toast/toast';

const app = getApp<IAppOption>();

const TIME_SLOTS = [
  { text: '上午 09:00-11:00', value: '09:00-11:00' },
  { text: '上午 11:00-13:00', value: '11:00-13:00' },
  { text: '下午 13:00-15:00', value: '13:00-15:00' },
  { text: '下午 15:00-17:00', value: '15:00-17:00' },
  { text: '下午 17:00-19:00', value: '17:00-19:00' },
];

// 调用 clientApi 云函数
async function callClientApi(action: string, payload: Record<string, any> = {}) {
  const res = await wx.cloud.callFunction({
    name: 'clientApi',
    data: { action, payload }
  }) as any;
  if (res.result?.code !== 0) {
    const err: any = new Error(res.result?.message || '请求失败');
    err.code = res.result?.code;
    throw err;
  }
  return res.result.data;
}

Page({
  data: {
    // 可预约项目列表（从订单列表中筛选已支付且有剩余次数的订单项）
    appointableItems: [] as any[],
    selectedSaleItemId: '',
    selectedSaleOrderId: '',

    // 时间
    appointmentDate: '',
    appointmentTimeSlot: '',
    _timeSlotDisplay: '',
    minDate: 0,
    maxDate: 0,

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
    showPhoneBind: false,
  },

  onLoad(options) {
    const now = Date.now();
    this.setData({
      minDate: now,
      maxDate: now + 90 * 24 * 60 * 60 * 1000,
    });
    const { saleOrderId, orderNo, employeeId, employeeName } = options as {
      saleOrderId?: string; orderNo?: string;
      employeeId?: string; employeeName?: string;
    };
    this.loadAppointableItems(saleOrderId || orderNo);
    this.loadStaffList();
    // 如果从美容师详情页传入了 employeeId，优先使用
    if (employeeId) {
      this.setData({
        selectedStaffWfId: employeeId,
        selectedStaffName: employeeName ? decodeURIComponent(employeeName) : '',
      });
    } else {
      this.loadDefaultStaff();
    }
  },

  async loadAppointableItems(filterSaleOrderId?: string) {
    try {
      const data = await callClientApi('order.appointableItems');
      const orders: any[] = data?.orders || [];
      const items: any[] = [];
      for (const order of orders) {
        if (filterSaleOrderId && order.saleOrderId !== filterSaleOrderId) continue;
        for (const item of order.items) {
          items.push({
            sale_item_id: item.saleItemId,
            product_name: item.productName,
            sku_spec_name: item.skuSpecName,
            remaining_sessions: item.remainingSessions,
            session_count: item.sessionCount,
            product_type: item.productType,
            sale_order_id: order.saleOrderId,
            store_name: order.storeName,
          });
        }
      }
      this.setData({ appointableItems: items });
    } catch {
      Toast.fail('加载可预约项目失败');
    }
  },

  async loadStaffList() {
    try {
      const storeId = app.globalData.boundStoreId;
      if (!storeId) return;
      const data = await callClientApi('staff.list', { storeId });
      const staffList = (data?.staffList || []).map((s: any) => ({
        employee_id: s.staff_id,
        name: s.name,
        position: s.position,
      }));
      this.setData({ staffList });
    } catch {
      // 静默失败，美容师列表不影响预约
    }
  },

  async loadDefaultStaff() {
    try {
      const data = await callClientApi('staff.default', {});
      if (data?.mainStaffId) {
        this.setData({
          selectedStaffWfId: data.mainStaffId,
          selectedStaffName: data.mainStaffName || '',
        });
      }
    } catch {
      // 获取默认美容师失败不影响预约流程
    }
  },

  onSelectItem(e: WechatMiniprogram.TouchEvent) {
    const item = e.currentTarget.dataset.item as any;
    this.setData({
      selectedSaleItemId: item.sale_item_id,
      selectedSaleOrderId: item.sale_order_id,
    });
  },

  onClearItem() {
    this.setData({ selectedSaleItemId: '', selectedSaleOrderId: '' });
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

  onTimeConfirm(e: WechatMiniprogram.CustomEvent) {
    const { index } = e.detail;
    const slot = TIME_SLOTS[index];
    if (slot) {
      this.setData({
        appointmentTimeSlot: slot.value,        // "HH:MM-HH:MM" 供提交
        _timeSlotDisplay: slot.text,            // 中文展示
        showTimePicker: false,
      });
    }
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
    wx.navigateTo({ url: '/pagesOrder/orders/orders' });
  },

  async onSubmit() {
    const { selectedSaleItemId, appointmentDate, appointmentTimeSlot, selectedStaffWfId, selectedStaffName, notes } = this.data;
    if (!appointmentDate || !appointmentTimeSlot) {
      Toast('请选择预约日期和时段');
      return;
    }
    if (this.data.submitting) return;
    this.setData({ submitting: true });
    try {
      await callClientApi('appointment.create', {
        saleItemId: selectedSaleItemId || null,
        appointmentTime: `${appointmentDate} ${appointmentTimeSlot}`,
        staffWfId: selectedStaffWfId || null,
        staffName: selectedStaffName || null,
        notes: notes.trim() || null,
      });
      Toast.success('预约申请已提交');
      setTimeout(() => {
        wx.switchTab({ url: '/pages/appointment/appointment' });
      }, 1500);
    } catch (err: any) {
      if (err?.code === -403 && err?.message?.includes('PHONE_REQUIRED')) {
        this.setData({ showPhoneBind: true });
        return;
      }
      Toast.fail(err?.message || '提交失败，请重试');
    } finally {
      this.setData({ submitting: false });
    }
  },

  onClosePhoneBind() {
    this.setData({ showPhoneBind: false });
  },

  async onGetPhoneNumber(e: WechatMiniprogram.TouchEvent) {
    const { cloudID, errMsg } = e.detail;
    if (!cloudID) {
      if (errMsg?.includes('auth deny')) {
        Toast('您拒绝了授权');
      }
      return;
    }
    try {
      wx.showLoading({ title: '绑定中...', mask: true });
      const res = await wx.cloud.callFunction({
        name: 'clientApi',
        data: {
          action: 'auth.bindPhone',
          payload: {},
          phoneData: wx.cloud.CloudID(cloudID as string)
        }
      }) as any;
      wx.hideLoading();
      if (res.result?.code !== 0) {
        throw new Error(res.result?.message || '绑定失败');
      }
      wx.setStorageSync('phone', res.result.data.phone);
      this.setData({ showPhoneBind: false });
      Toast.success('绑定成功');
      // 绑定成功后自动重新提交预约
      setTimeout(() => this.onSubmit(), 800);
    } catch (err: any) {
      wx.hideLoading();
      Toast.fail(err.message || '绑定失败，请重试');
    }
  },

  onShareAppMessage() {
    return { title: '凤御预约', path: '/pages/appointment/appointment' };
  },
});
