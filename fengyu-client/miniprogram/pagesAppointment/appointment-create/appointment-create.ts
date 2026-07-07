
import Toast from '@vant/weapp/toast/toast';
import { callClientApi, bindPhoneWithCloudID } from '../../utils/cloud';
import { formatDate } from '../../utils/format';

const app = getApp<IAppOption>();

const TIME_SLOTS = [
  { label: '09-10', text: '上午 09:00-10:00', value: '09:00-10:00' },
  { label: '10-11', text: '上午 10:00-11:00', value: '10:00-11:00' },
  { label: '11-12', text: '上午 11:00-12:00', value: '11:00-12:00' },
  { label: '12-13', text: '下午 12:00-13:00', value: '12:00-13:00' },
  { label: '13-14', text: '下午 13:00-14:00', value: '13:00-14:00' },
  { label: '14-15', text: '下午 14:00-15:00', value: '14:00-15:00' },
  { label: '15-16', text: '下午 15:00-16:00', value: '15:00-16:00' },
  { label: '16-17', text: '下午 16:00-17:00', value: '16:00-17:00' },
  { label: '17-18', text: '下午 17:00-18:00', value: '17:00-18:00' },
  { label: '18-19', text: '下午 18:00-19:00', value: '18:00-19:00' },
];

Page({
  data: {
    
    appointableItems: [] as any[],
    selectedSaleItemId: '',
    selectedSaleOrderId: '',

    
    appointmentDate: '',
    appointmentTimeSlot: '',
    _timeSlotDisplay: '',
    minDate: 0,
    maxDate: 0,

    
    staffList: [] as any[],
    defaultStaffName: '',
    selectedStaffWfId: '',
    selectedStaffName: '',
    selectedStaffAvatarUrl: '',

    notes: '',

    
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
      
      const bookingStoreId = app.globalData.boundStoreId || '';
      const items: any[] = [];
      for (const order of orders) {
        if (filterSaleOrderId && order.saleOrderId !== filterSaleOrderId) continue;
        for (const item of (order.items || [])) {
          
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
        avgRating: s.avgRating ?? null,
        reviewCount: s.reviewCount || 0,
        leaveStart: s.leaveStart || null,
        leaveEnd: s.leaveEnd || null,
        onLeave: false,
      }));
      this.setData({ staffList });
      this._recomputeStaffLeave();
    } catch {
      
    }
  },

  
  _recomputeStaffLeave() {
    const { appointmentDate, appointmentTimeSlot, staffList, selectedStaffWfId } = this.data;
    let slotStartMs: number | null = null;
    if (appointmentDate && appointmentTimeSlot) {
      const startHM = appointmentTimeSlot.split('-')[0]; 
      slotStartMs = new Date(`${appointmentDate}T${startHM}:00`).getTime();
    }
    const list = (staffList as any[]).map((s) => {
      let onLeave = false;
      if (slotStartMs !== null && s.leaveStart && s.leaveEnd) {
        
        const ls = new Date(s.leaveStart).getTime();
        const le = new Date(s.leaveEnd).getTime();
        onLeave = !isNaN(ls) && !isNaN(le) && slotStartMs >= ls && slotStartMs <= le;
      }
      return { ...s, onLeave };
    });
    const patch: Record<string, any> = { staffList: list };
    
    if (selectedStaffWfId) {
      const sel = list.find((s) => s.employee_id === selectedStaffWfId);
      if (sel && sel.onLeave) {
        patch.selectedStaffWfId = '';
        patch.selectedStaffName = '';
        patch.selectedStaffAvatarUrl = '';
        Toast('该美容师该时段休假中，已取消选择');
      }
    }
    this.setData(patch);
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
    this._recomputeStaffLeave();
  },

  
  _updateDisabledSlots(dateStr: string) {
    const today = formatDate(new Date().toISOString());
    const isToday = dateStr === today;
    const currentHour = new Date().getHours();

    const updatedSlots = TIME_SLOTS.map(slot => {
      
      const startHour = parseInt(slot.value.split(':')[0], 10);
      const disabled = isToday && currentHour >= startHour;
      return { ...slot, disabled };
    });
    this.setData({ timeSlots: updatedSlots });

    
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
    this._recomputeStaffLeave();
  },

  onShowStaffPopup() {
    this.setData({ showStaffPopup: true });
  },

  onCloseStaffPopup() {
    this.setData({ showStaffPopup: false });
  },

  onStaffSelect(e: WechatMiniprogram.CustomEvent<{ wfId: string; name: string }>) {
    const { wfId, name } = e.detail;
    
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
      
      setTimeout(() => this.onSubmit(), 800);
    } catch (err: any) {
      Toast.fail(err.message || '绑定失败，请重试');
    }
  },

  onShareAppMessage() {
    
    const app = getApp<IAppOption>();
    const userId = app.globalData.userId;
    const invSuffix = userId ? `?inv=${encodeURIComponent(userId)}` : '';
    return { title: '凤御预约', path: `/pages/home/home${invSuffix}` };
  },
});
