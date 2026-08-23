// pages/appointment-create/appointment-create.ts
import Toast from '@vant/weapp/toast/toast';
import { callClientApi, bindPhoneWithCloudID } from '../../utils/cloud';
import { formatDate } from '../../utils/format';
import { getTreatmentCardBusinessIdentity, groupTreatmentCards, sumGroupValue } from '../utils/treatment-card-group';

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
    // 可预约项目列表（从订单列表中筛选已支付且有剩余次数的订单项）
    appointableItems: [] as any[],
    selectedSaleItemId: '',
    selectedSaleOrderId: '',
    selectedSaleItemGroupKey: '',

    // 时间
    appointmentDate: '',
    appointmentTimeSlot: '',
    _timeSlotDisplay: '',
    minDate: 0,
    maxDate: 0,

    // 美容师
    staffList: [] as any[],
    // employeeId -> 该日已占用时段起点列表（['10:00', ...]），由 staffSchedule 拉取
    staffBusyMap: {} as Record<string, string[]>,
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
          // 疗程卡（含原单品=1 次卡）可预约；必须本店可用 + 有已付未用次数
          const itemStoreId = item.storeId || order.storeId || '';
          const isCrossStore = !!bookingStoreId && !!itemStoreId && itemStoreId !== bookingStoreId;
          if (isCrossStore) continue;
          const total = Number(item.sessionCount ?? 0);
          const remaining = Number(item.remainingSessions ?? 0);
          const paidRaw = item.paidSessions;
          const paid = Number(paidRaw ?? 0);
          const used = Math.max(0, total - remaining);
          const paidUnused = Math.max(0, paid - used);
          // NULL 卡（migration 0040 前创建、未被 recalc 回填的历史卡）：
          //   显示但 disabled 不可核销（灰显 + close icon + Toast 拦截，复用 .item-disabled 基础设施）。
          //   非 NULL 但 paid=0 / 已用满已付 的卡仍隐藏（continue）。
          const isNullCard = paidRaw == null;
          if (!isNullCard && !(paid > 0 && paidUnused > 0)) continue;
          items.push({
            sale_item_id: item.saleItemId,
            product_name: item.productName,
            remaining_sessions: remaining,
            session_count: total,
            unit: item.unit || '次',
            paid_sessions: paid,
            used_sessions: used,
            paid_unused_sessions: isNullCard ? 0 : paidUnused,
            product_type: item.productType,
            sale_order_id: order.saleOrderId,
            sale_order_datetime: order.saleOrderDatetime,
            paid_at: order.paidAt,
            order_status: order.orderStatus,
            sale_order_type: order.saleOrderType,
            document_type: order.documentType,
            legacy_source: order.legacySource,
            store_id: itemStoreId,
            store_name: order.storeName,
            market_name: order.marketName,
            sku_id: item.skuId,
            item_direction: item.itemDirection,
            ref_sale_item_id: item.refSaleItemId,
            unit_price: item.unitPrice,
            unit_real_price: item.unitRealPrice,
            sale_amount: item.saleAmount,
            received: item.received,
            pending_received: item.pendingReceived,
            expire_date: item.expireDate,
            remark: item.remark,
            sales_category: item.salesCategory,
            picked_up_quantity: item.pickedUpQuantity,
            product_kind: item.productKind,
            category_id: item.categoryId,
            category_name: item.categoryName,
            quantity: Number(item.quantity ?? 1),
            disabled: isNullCard,
            disabled_reason: isNullCard ? '历史卡未回填,不可核销' : '',
          });
        }
      }
      // 当指定了 saleItemId 时（来自疗程卡页），自动预选对应项目；跨店卡不预选
      const groupedItems = groupTreatmentCards(items, {
        getId: (item) => item.sale_item_id,
        getQuantity: (item) => item.quantity,
        getIdentity: (item) => getTreatmentCardBusinessIdentity(item),
      }).map((group) => {
        const primary = group.primary;
        const disabled = !!primary.disabled;
        return {
          ...primary,
          group_key: group.groupKey,
          sale_item_id: primary.sale_item_id,
          quantity: sumGroupValue(group, (item) => item.quantity ?? 1),
          card_count: group.cardCount,
          session_count: sumGroupValue(group, (item) => item.session_count),
          remaining_sessions: sumGroupValue(group, (item) => item.remaining_sessions),
          paid_sessions: disabled ? 0 : sumGroupValue(group, (item) => item.paid_sessions),
          used_sessions: sumGroupValue(group, (item) => item.used_sessions),
          paid_unused_sessions: disabled ? 0 : sumGroupValue(group, (item) => item.paid_unused_sessions),
          source_items: group.sourceItems,
        };
      });
      const preselectGroup = preselectItemId
        ? groupedItems.find((item) => item.source_items.some((source: any) => source.sale_item_id === preselectItemId) && !item.disabled)
        : null;
      const preselectSource = preselectGroup && preselectItemId
        ? preselectGroup.source_items.find((source: any) => source.sale_item_id === preselectItemId)
        : null;
      this.setData({
        appointableItems: groupedItems,
        ...(preselectGroup && preselectSource ? {
          selectedSaleItemId: preselectSource.sale_item_id,
          selectedSaleOrderId: preselectSource.sale_order_id,
          selectedSaleItemGroupKey: preselectGroup.group_key,
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
        booked: false,
      }));
      this.setData({ staffList });
      this._recomputeStaffAvailability();
      // staffList 异步到达（含 leaveStart/leaveEnd）后刷新时段行置灰（leave 维度依赖 staffList）
      this._recomputeSlotDisabled();
    } catch {
      // 静默失败，美容师列表不影响预约
    }
  },

  /**
   * 依据当前所选预约日期 + 时段，重算每个美容师在该时段的可用性：
   *   - onLeave：时段起点 ∈ [leaveStart, leaveEnd]（与后端 appointment.create 同口径）
   *   - booked：该美容师该时段起点 ∈ staffBusyMap[employeeId]（staffSchedule 拉取的当日占用）
   * 未选日期/时段时无法判定，全部置 false（交由提交时后端兜底）。
   */
  _recomputeStaffAvailability() {
    const { appointmentDate, appointmentTimeSlot, staffList, selectedStaffWfId, staffBusyMap } = this.data;
    let slotStartMs: number | null = null;
    let slotStart = '';
    if (appointmentDate && appointmentTimeSlot) {
      slotStart = appointmentTimeSlot.split('-')[0]; // "10:00"
      slotStartMs = new Date(`${appointmentDate}T${slotStart}:00`).getTime();
    }
    const busyMap = staffBusyMap as Record<string, string[]>;
    const list = (staffList as any[]).map((s) => {
      let onLeave = false;
      if (slotStartMs !== null && s.leaveStart && s.leaveEnd) {
        // leaveStart/leaveEnd 为墙钟串（YYYY-MM-DDTHH:mm:ss），按设备本地解析，与 slotStartMs 同基准
        const ls = new Date(s.leaveStart).getTime();
        const le = new Date(s.leaveEnd).getTime();
        onLeave = !isNaN(ls) && !isNaN(le) && slotStartMs >= ls && slotStartMs <= le;
      }
      const booked = !!slotStart && (busyMap[s.employee_id] || []).includes(slotStart);
      return { ...s, onLeave, booked };
    });
    const patch: Record<string, any> = { staffList: list };
    // 切换时段后，若已选美容师在新时段休假或已约满，清空选择并提示
    if (selectedStaffWfId) {
      const sel = list.find((s) => s.employee_id === selectedStaffWfId);
      if (sel && (sel.onLeave || sel.booked)) {
        patch.selectedStaffWfId = '';
        patch.selectedStaffName = '';
        patch.selectedStaffAvatarUrl = '';
        Toast(sel.onLeave ? '该美容师该时段休息中，已取消选择' : '该美容师该时段已约满，已取消选择');
      }
    }
    this.setData(patch);
  },

  /**
   * 拉取指定日期该门店各美容师的时段占用（待确认/已确认），用于弹层标注「已约满」。
   * 失败静默（不阻塞预约，后端 create 兜底冲突检测）。
   */
  async loadStaffSchedule(date: string) {
    const storeId = app.globalData.boundStoreId;
    if (!storeId || !date) return;
    try {
      const data = await callClientApi<{ staffSchedule: { employeeId: string; busySlots: string[] }[] }>(
        'appointment.staffSchedule',
        { storeId, date },
      );
      const busyMap: Record<string, string[]> = {};
      for (const item of data?.staffSchedule || []) {
        busyMap[item.employeeId] = item.busySlots || [];
      }
      // 日期守卫：await 期间用户若已改选其它日期，丢弃本次 stale 响应（避免旧日期 busyMap 覆盖新日期致误置灰）
      if (this.data.appointmentDate !== date) return;
      this.setData({ staffBusyMap: busyMap });
    } catch {
      // 静默失败：保持空（onDateConfirm 切日期时已清空旧 map），不阻塞预约流程；
      // 不回填旧日期占用以免新日期被误置灰，冲突由后端 appointment.create 兜底。
    }
    this._recomputeStaffAvailability();
    // busyMap 更新后，若已选美容师，其约满时段需重新置灰（覆盖「先选美容师再选日期」时序）
    this._recomputeSlotDisabled();
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
        // 默认美容师异步回填后刷新时段行置灰（booked 维度依赖 selectedStaffWfId）
        this._recomputeSlotDisabled();
      }
    } catch {
      // 获取默认美容师失败不影响预约流程
    }
  },

  onSelectItem(e: WechatMiniprogram.TouchEvent) {
    const {
      saleItemId,
      saleOrderId,
      groupKey,
      disabled,
      disabledReason,
    } = e.currentTarget.dataset as {
      saleItemId?: string;
      saleOrderId?: string;
      groupKey?: string;
      disabled?: boolean | string;
      disabledReason?: string;
    };
    if (disabled === true || disabled === 'true') {
      Toast(disabledReason || '该卡不可用于当前门店');
      return;
    }
    if (!saleItemId || !saleOrderId || !groupKey) return;
    this.setData({
      selectedSaleItemId: saleItemId,
      selectedSaleOrderId: saleOrderId,
      selectedSaleItemGroupKey: groupKey,
    });
  },

  onClearItem() {
    this.setData({ selectedSaleItemId: '', selectedSaleOrderId: '', selectedSaleItemGroupKey: '' });
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
    // 切日期时立即清空旧日期的时段占用，避免下方同步 _recomputeSlotDisabled 拿上一日期的
    // busySlots 把新日期的时段误置灰。真实占用由 loadStaffSchedule 成功后回填，失败则保持空
    // （宽松口径——冲突仍由后端 appointment.create 权威兜底，不会双订）。
    this.setData({ appointmentDate: fmt, showCalendar: false, staffBusyMap: {} });
    this._recomputeSlotDisabled();
    this.loadStaffSchedule(fmt);
  },

  /**
   * 依据「所选美容师 + 当前日期」重算每个时段的可选性（时段维度，与 _recomputeStaffAvailability 互补）：
   *   - past：今天且当前小时>=时段起点小时（已过）
   *   - booked：选了美容师且该时段起点 ∈ staffBusyMap[该美容师]（已约满）
   *   - leave：选了美容师且时段起点 ∈ [leaveStart, leaveEnd]（休息中，墙钟口径同 _recomputeStaffAvailability）
   * 任一成立即 disabled。若已选时段被新判定置灰，清空选择并按原因 Toast。
   */
  _recomputeSlotDisabled() {
    const { appointmentDate, selectedStaffWfId, staffList, staffBusyMap, appointmentTimeSlot } = this.data;
    const staffId = selectedStaffWfId as string;
    const hasStaff = !!staffId;
    const today = formatDate(new Date().toISOString());
    const isToday = !!appointmentDate && appointmentDate === today;
    const currentHour = new Date().getHours();
    const selStaff = hasStaff
      ? (staffList as any[]).find((s) => s.employee_id === staffId)
      : null;
    const busySlots = hasStaff ? (staffBusyMap as Record<string, string[]>)[staffId] || [] : [];
    let leaveStartMs = NaN;
    let leaveEndMs = NaN;
    if (selStaff?.leaveStart && selStaff?.leaveEnd) {
      // leaveStart/leaveEnd 为墙钟串（YYYY-MM-DDTHH:mm:ss），按设备本地解析
      leaveStartMs = new Date(selStaff.leaveStart).getTime();
      leaveEndMs = new Date(selStaff.leaveEnd).getTime();
    }

    const updatedSlots = TIME_SLOTS.map((slot) => {
      const startHour = parseInt(slot.value.split(':')[0], 10); // '09:00-10:00' → 9
      const slotStart = slot.value.split('-')[0]; // 'HH:MM'，与 busySlots 同口径
      let disabled = false;
      let disabledReason = '';
      if (isToday && currentHour >= startHour) {
        disabled = true;
        disabledReason = 'past';
      } else if (hasStaff && busySlots.includes(slotStart)) {
        disabled = true;
        disabledReason = 'booked';
      } else if (hasStaff && !isNaN(leaveStartMs) && !isNaN(leaveEndMs) && appointmentDate) {
        const slotMs = new Date(`${appointmentDate}T${slotStart}:00`).getTime();
        if (!isNaN(slotMs) && slotMs >= leaveStartMs && slotMs <= leaveEndMs) {
          disabled = true;
          disabledReason = 'leave';
        }
      }
      return { ...slot, disabled, disabledReason };
    });

    const patch: Record<string, any> = { timeSlots: updatedSlots };
    // 若已选时段被置灰（如切换到冲突美容师），清空选择并提示
    if (appointmentTimeSlot) {
      const selected = updatedSlots.find((s) => s.value === appointmentTimeSlot);
      if (selected?.disabled) {
        patch.appointmentTimeSlot = '';
        patch._timeSlotDisplay = '';
        const msg = selected.disabledReason === 'booked'
          ? '该美容师该时段已约满，已取消时段'
          : selected.disabledReason === 'leave'
            ? '该美容师该时段休息中，已取消时段'
            : '所选时段已过，已取消时段';
        Toast(msg);
      }
    }
    this.setData(patch);
  },

  onTimeSlotTap(e: WechatMiniprogram.TouchEvent) {
    const { value, text, disabled, disabledReason } = e.currentTarget.dataset as { value: string; text: string; disabled?: boolean | string; disabledReason?: string };
    const isDisabled = disabled === true || disabled === 'true';
    if (isDisabled) {
      const msg = disabledReason === 'booked'
        ? '该美容师该时段已约满'
        : disabledReason === 'leave'
          ? '该美容师该时段休息中'
          : '该时段已过，请选择其他时段';
      Toast(msg);
      return;
    }
    this.setData({
      appointmentTimeSlot: value,
      _timeSlotDisplay: text,
    });
    this._recomputeStaffAvailability();
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
    // 选/换/清空美容师后，重算时段置灰（核心触发点）
    this._recomputeSlotDisabled();
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
        this._recomputeSlotDisabled();
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
