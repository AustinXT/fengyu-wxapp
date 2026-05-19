// pages/appointment-create/appointment-create.ts
import Toast from '@vant/weapp/toast/toast';
import { callClientApi, bindPhoneWithCloudID } from '../../utils/cloud';
import { formatDate } from '../../utils/format';

const app = getApp<IAppOption>();

const TIME_SLOTS = [
  { label: '09-11', text: '上午 09:00-11:00', value: '09:00-11:00' },
  { label: '11-13', text: '上午 11:00-13:00', value: '11:00-13:00' },
  { label: '13-15', text: '下午 13:00-15:00', value: '13:00-15:00' },
  { label: '15-17', text: '下午 15:00-17:00', value: '15:00-17:00' },
  { label: '17-19', text: '下午 17:00-19:00', value: '17:00-19:00' },
];

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
    selectedStaffAvatarUrl: '',

    notes: '',

    // UI 状态
    showCalendar: false,
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
    const { saleOrderId, orderNo, saleItemId, employeeId, employeeName } = options as {
      saleOrderId?: string; orderNo?: string; saleItemId?: string;
      employeeId?: string; employeeName?: string;
    };
    this.loadAppointableItems(saleOrderId || orderNo, saleItemId);
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

  async loadAppointableItems(filterSaleOrderId?: string, preselectItemId?: string) {
    try {
      const data = await callClientApi('order.appointableItems');
      const orders: any[] = data?.orders || [];
      // 当前绑定门店作为"预约门店"；非本店卡需要禁用以符合"一张卡只能在购买门店使用"业务规则
      const bookingStoreId = app.globalData.boundStoreId || '';
      const items: any[] = [];
      for (const order of orders) {
        if (filterSaleOrderId && order.saleOrderId !== filterSaleOrderId) continue;
        for (const item of (order.items || [])) {
          // 疗程卡 + 单品都可预约；必须本店可用 + 有已付未用次数
          const itemStoreId = order.storeId || '';
          const isCrossStore = !!bookingStoreId && !!itemStoreId && itemStoreId !== bookingStoreId;
          if (isCrossStore) continue;
          const total = Number(item.sessionCount ?? 0);
          const remaining = Number(item.remainingSessions ?? 0);
          const paid = Number(item.paidSessions ?? 0);
          const used = Math.max(0, total - remaining);
          const paidUnused = Math.max(0, paid - used);
          if (!(paid > 0 && paidUnused > 0)) continue;
          items.push({
            sale_item_id: item.saleItemId,
            product_name: item.productName,
            sku_spec_name: item.skuSpecName,
            remaining_sessions: remaining,
            session_count: total,
            paid_sessions: paid,
            used_sessions: used,
            paid_unused_sessions: paidUnused,
            product_type: item.productType,
            sale_order_id: order.saleOrderId,
            store_id: itemStoreId,
            store_name: order.storeName,
            disabled: false,
            disabled_reason: '',
          });
        }
      }
      // 当指定了 saleItemId 时（来自疗程卡页），自动预选对应项目；跨店卡不预选
      const preselect = preselectItemId
        ? items.find(i => i.sale_item_id === preselectItemId && !i.disabled)
        : null;
      this.setData({
        appointableItems: items,
        ...(preselect ? {
          selectedSaleItemId: preselect.sale_item_id,
          selectedSaleOrderId: preselect.sale_order_id,
        } : {}),
      });
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
        avatarUrl: s.avatarUrl || '',
      }));
      this.setData({ staffList });
    } catch {
      // 静默失败，美容师列表不影响预约
    }
  },

  async loadDefaultStaff() {
    try {
      const data = await callClientApi<{
        mainStaffId: string | null;
        mainStaffName: string | null;
        mainStaffAvatarUrl: string | null;
      }>('staff.default', {});
      if (data?.mainStaffId) {
        this.setData({
          selectedStaffWfId: data.mainStaffId,
          selectedStaffName: data.mainStaffName || '',
          selectedStaffAvatarUrl: data.mainStaffAvatarUrl || '',
        });
      }
    } catch {
      // 获取默认美容师失败不影响预约流程
    }
  },

  onSelectItem(e: WechatMiniprogram.TouchEvent) {
    const item = e.currentTarget.dataset.item as any;
    if (item.disabled) {
      Toast(item.disabled_reason || '该卡不可用于当前门店');
      return;
    }
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
    const fmt = formatDate(d.toISOString());
    this.setData({ appointmentDate: fmt, showCalendar: false });
    this._updateDisabledSlots(fmt);
  },

  /** 当选日期为今天时，禁用已过去的时段；切换到非今天时全部可选 */
  _updateDisabledSlots(dateStr: string) {
    const today = formatDate(new Date().toISOString());
    const isToday = dateStr === today;
    const currentHour = new Date().getHours();

    const updatedSlots = TIME_SLOTS.map(slot => {
      // 取时段开始小时：'09:00-11:00' → 9
      const startHour = parseInt(slot.value.split(':')[0], 10);
      const disabled = isToday && currentHour >= startHour;
      return { ...slot, disabled };
    });
    this.setData({ timeSlots: updatedSlots });

    // 若当前已选时段变为禁用，则清空选择
    if (this.data.appointmentTimeSlot) {
      const selected = updatedSlots.find(s => s.value === this.data.appointmentTimeSlot);
      if (selected?.disabled) {
        this.setData({ appointmentTimeSlot: '', _timeSlotDisplay: '' });
      }
    }
  },

  onTimeSlotTap(e: WechatMiniprogram.TouchEvent) {
    const { value, text, disabled } = e.currentTarget.dataset as { value: string; text: string; disabled?: boolean | string };
    const isDisabled = disabled === true || disabled === 'true';
    if (isDisabled) {
      Toast('该时段已过，请选择其他时段');
      return;
    }
    this.setData({
      appointmentTimeSlot: value,
      _timeSlotDisplay: text,
    });
  },

  onShowStaffPopup() {
    this.setData({ showStaffPopup: true });
  },

  onCloseStaffPopup() {
    this.setData({ showStaffPopup: false });
  },

  onStaffSelect(e: WechatMiniprogram.CustomEvent<{ wfId: string; name: string }>) {
    const { wfId, name } = e.detail;
    // 从已加载的 staffList 里反查头像（弹层 select 事件只携带 id/name，避免破坏现有契约）
    const matched = (this.data.staffList as any[]).find((s) => s.employee_id === wfId);
    this.setData({
      selectedStaffWfId: wfId,
      selectedStaffName: name,
      selectedStaffAvatarUrl: matched?.avatarUrl || '',
      showStaffPopup: false,
    });
  },

  onGoOrders() {
    wx.navigateTo({ url: '/pagesOrder/orders/orders' });
  },

  async onSubmit() {
    const { selectedSaleItemId, appointmentDate, appointmentTimeSlot, selectedStaffWfId, selectedStaffName, notes } = this.data;
    if (!appointmentDate || !appointmentTimeSlot) {
      Toast.fail('请选择预约日期和时段');
      return;
    }
    // 安全校验：防止提交当天已过时段
    const today = formatDate(new Date().toISOString());
    if (appointmentDate === today) {
      const startHour = parseInt(appointmentTimeSlot.split(':')[0], 10);
      if (new Date().getHours() >= startHour) {
        Toast.fail('所选时段已过，请重新选择');
        this._updateDisabledSlots(appointmentDate);
        return;
      }
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
      if (err?.errorType === 'PHONE_REQUIRED') {
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
        Toast.fail('您拒绝了授权');
      }
      return;
    }
    try {
      await bindPhoneWithCloudID(cloudID as string);
      this.setData({ showPhoneBind: false });
      Toast.success('绑定成功');
      // 绑定成功后自动重新提交预约
      setTimeout(() => this.onSubmit(), 800);
    } catch (err: any) {
      Toast.fail(err.message || '绑定失败，请重试');
    }
  },

  onShareAppMessage() {
    // 分享礼：被分享人进入首页而非分享者的预约页
    const app = getApp<IAppOption>();
    const userId = app.globalData.userId;
    const invSuffix = userId ? `?inv=${encodeURIComponent(userId)}` : '';
    return { title: '凤御预约', path: `/pages/home/home${invSuffix}` };
  },
});
