// pages/appointment-create/appointment-create.ts
import Toast from '@vant/weapp/toast/toast';

const app = getApp<IAppOption>();

const TIME_SLOTS = ['上午 09:00-11:00', '上午 11:00-13:00', '下午 13:00-15:00', '下午 15:00-17:00', '下午 17:00-19:00'];

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
      // 获取用户所有已支付订单
      const data = await callClientApi('order.list', { status: '已支付' });
      const orders = data?.orders || [];

      // 从订单详情中筛选有剩余次数的项目
      const appointableItems = [];
      for (const order of orders) {
        const detailData = await callClientApi('order.detail', { orderNo: order.order_no });
        const items = detailData?.items || [];
        for (const item of items) {
          // 非院装产品且剩余次数 > 0
          if (item.product_type !== '院装产品' && (item.remaining_sessions ?? 0) > 0) {
            appointableItems.push({
              ...item,
              order_no: order.order_no,
              order_datetime: order.order_datetime,
              store_name: order.store_name,
              // 如果有筛选，按订单号过滤
              hidden: filterOrderNo && order.order_no !== filterOrderNo
            });
          }
        }
      }

      // 过滤隐藏项并返回
      const filtered = filterOrderNo
        ? appointableItems.filter((item: any) => !item.hidden)
        : appointableItems;

      this.setData({ appointableItems: filtered });
    } catch {
      Toast.fail('加载可预约项目失败');
    }
  },

  async loadStaffList() {
    try {
      const storeName = app.globalData.boundStoreName;
      if (!storeName) return;
      const data = await callClientApi('staff.list', { storeName });
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
      await callClientApi('appointment.create', {
        itemFlowNo: selectedItemFlowNo,
        appointmentTime: `${appointmentDate} ${appointmentTimeSlot}`,
        staffWfId: selectedStaffWfId || null,
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
