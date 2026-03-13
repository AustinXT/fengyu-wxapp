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
    throw new Error(res.result?.message || '请求失败');
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
  },

  onLoad(options) {
    const now = Date.now();
    this.setData({
      minDate: now,
      maxDate: now + 90 * 24 * 60 * 60 * 1000,
    });
    const { saleOrderId, orderNo } = options as { saleOrderId?: string; orderNo?: string };
    this.loadAppointableItems(saleOrderId || orderNo);
    this.loadStaffList();
    this.loadDefaultStaff();
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
      this.setData({ staffList: data?.staffList || [] });
    } catch {
      // 静默失败，美容师列表不影响预约
    }
  },

  async loadDefaultStaff() {
    // TODO: 云函数需要新增获取默认美容师接口
    // 临时实现：尝试从用户信息中获取（如果后端有存储）
    try {
      // 暂时不做处理，等待后端接口
    } catch {
      // 静默失败
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
      this.setData({ appointmentTimeSlot: slot.text, showTimePicker: false });
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
      Toast.fail(err?.message || '提交失败，请重试');
    } finally {
      this.setData({ submitting: false });
    }
  },

  onShareAppMessage() {
    return { title: '凤御预约', path: '/pages/appointment/appointment' };
  },
});
