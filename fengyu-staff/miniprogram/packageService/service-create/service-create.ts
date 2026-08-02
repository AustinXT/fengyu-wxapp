// pages/service-create/service-create.ts — 创建服务单
import { callStaffApi } from '../../utils/cloud';
import { formatDateTime, ORDER_TYPE_LABEL } from '../../utils/formatters';
import { isManager } from '../../utils/role';

// 寄存单退款专用标准化备注（数据契约）。寄存单是上线时导入老系统历史剩余次数的初始化单据，未走收款流程、
// 无法开正常退款单；退寄存疗程卡次数时走正常服务单扣减次数并在备注选此预设打标，供后续从消耗业绩统计过滤。
// ⚠️ 须与 fengyu-admin/src/lib/service-remark.ts 的 DEPOSIT_REFUND_REMARK 字面量完全一致
//    （项目禁止跨端共享代码目录，各端保留独立副本）。
const DEPOSIT_REFUND_REMARK = '寄存单退款专用 — 老系统寄存疗程卡退款核销，不计消耗业绩';

const app = getApp<IAppOption>();

interface PaidOrderItem {
  saleItemId: string;
  itemName: string;
  spec: string;
  sessionCount: number;
  remainingSessions: number;
  totalSessions: number;
  paidSessions: number | null;
  /** 可消费次数 = min(remaining, paid - used) = min(remaining, paid - (total - remaining)) */
  consumableSessions: number;
  productType: string;
  storeId?: string;
  /** NULL 卡（paid_sessions 为 null 的历史卡）置 true：灰显不可核销 */
  disabled?: boolean;
  disabledReason?: string;
  /** 单次优惠后价（unit_real_price，应付口径；全额已付卡下=单次实付） */
  unitRealPrice?: string;
  /** 品项标签（product_categories.category_name） */
  category?: string;
  /** 品项标签色（display_color） */
  categoryColor?: string;
  /** 单据类型展示文案（ORDER_TYPE_LABEL 映射后） */
  saleOrderTypeLabel?: string;
  /** 拍平后回填：所属销售单号 */
  saleOrderId?: string;
  /** 拍平后回填：支付时间（已格式化） */
  paidAt?: string;
}

interface PaidOrder {
  orderId: string;
  saleOrderId: string;
  paidAt: string;
  storeId?: string;
  storeName?: string;
  /** 单据类型（sale_orders.sale_order_type） */
  saleOrderType?: string;
  items: PaidOrderItem[];
}

interface OrderDetailForCreate {
  order: {
    client_user_id: string;
    customer_name: string;
    client_phone: string;
  };
}

interface AppointmentDetailForCreate {
  id: string;
  customerName: string;
  customerPhone: string;
  appointmentTime: string;
  serviceItemName: string;
  clientUserId: string | null;
}

interface CustomerSearchResult {
  id: string;
  name: string;
  phone: string;
  phoneMasked?: string;
  clientUserId?: string;
}

Page({
  data: {
    loading: false,
    submitting: false,
    // 来自预约
    appointmentId: '' as string,
    appointmentInfo: null as null | { id: string; customerName: string; appointmentTime: string; serviceItemName: string },
    // 顾客信息
    customerSearch: '',
    customerResults: [] as Array<{ id: string; name: string; phone: string; phoneMasked?: string; clientUserId?: string }>,
    selectedCustomer: null as null | { id: string; name: string; phone: string; clientUserId?: string },
    // 订单选择
    paidItems: [] as PaidOrderItem[],
    selectedItems: [] as Array<{ saleItemId: string; itemName: string; spec: string; saleOrderId: string; sessionCount: number }>,
    selectedFlowNos: {} as Record<string, boolean>, // 预计算的选中 saleItemId 集合，供 WXML 使用
    selectedSessionCounts: {} as Record<string, number>, // 预计算的选中 sessionCount，供 stepper 使用
    // 服务人员
    staffName: '',
    isManager: false,
    showStaffPicker: false,
    staffList: [] as Array<{ staffWfId: string; name: string; department: string; skills?: string[] }>,
    staffColumns: [] as string[],
    assignedStaffWfId: '' as string,
    // 备注
    remark: '',
    // 备注模式：custom=自由输入(默认，显示文本框)；preset=寄存单退款专用标准化备注
    remarkMode: 'custom' as 'custom' | 'preset',
    showRemarkPicker: false,
    remarkColumns: ['自定义输入（手动填写）', DEPOSIT_REFUND_REMARK] as string[],
  },

  onLoad(options) {
    const { staffName, staffWfId } = app.globalData;
    const mgr = isManager();
    this.setData({ staffName, isManager: mgr, assignedStaffWfId: staffWfId });
    if (mgr) {
      this.loadStaffList();
    }

    if (options.preloaded === '1') {
      const preload = app.globalData._serviceCreatePreload;
      app.globalData._serviceCreatePreload = null;
      if (preload) {
        const selectedItems = preload.items.map(i => ({
          saleItemId: i.saleItemId,
          itemName: i.itemName,
          spec: i.spec,
          saleOrderId: i.saleOrderId,
          sessionCount: i.sessionCount,
        }));
        const flowNos: Record<string, boolean> = {};
        const sessionCounts: Record<string, number> = {};
        selectedItems.forEach(s => { flowNos[s.saleItemId] = true; sessionCounts[s.saleItemId] = s.sessionCount; });
        this.setData({
          selectedCustomer: preload.customer,
          selectedItems,
          selectedFlowNos: flowNos,
          selectedSessionCounts: sessionCounts,
        });
        if (preload.customer.clientUserId || preload.customer.id) {
          this.loadPaidOrders(preload.customer.clientUserId || preload.customer.id);
        }
        return;
      }
    }

    if (options.appointmentId) {
      this.setData({ appointmentId: options.appointmentId });
      this.loadAppointmentInfo(options.appointmentId);
    } else if (options.saleOrderId) {
      this.loadOrderInfo(options.saleOrderId);
    }
  },

  async loadOrderInfo(saleOrderId: string) {
    this.setData({ loading: true });
    try {
      const data = await callStaffApi<OrderDetailForCreate>('order.detail', { saleOrderId });
      if (data?.order) {
        const order = data.order;
        const customer = {
          id: order.client_user_id || '',
          clientUserId: order.client_user_id || '',
          name: order.customer_name || '',
          phone: order.client_phone || '',
        };
        this.setData({ selectedCustomer: customer });
        if (customer.clientUserId || customer.id) {
          await this.loadPaidOrders(customer.clientUserId || customer.id);
        }
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : '加载失败';
      wx.showToast({ title: msg, icon: 'none' });
    } finally {
      this.setData({ loading: false });
    }
  },

  async loadAppointmentInfo(id: string) {
    try {
      const data = await callStaffApi<AppointmentDetailForCreate>('appointment.detail', { id });
      const customer = { id: data.clientUserId || '', name: data.customerName, phone: data.customerPhone };
      this.setData({
        appointmentInfo: {
          id: data.id,
          customerName: data.customerName,
          appointmentTime: data.appointmentTime,
          serviceItemName: data.serviceItemName,
        },
        selectedCustomer: customer,
        customerSearch: data.customerPhone,
      });
      if (customer.id) {
        this.loadPaidOrders(customer.id);
      }
    } catch (_) {}
  },

  onCustomerSearchChange(e: WechatMiniprogram.CustomEvent) {
    this.setData({ customerSearch: e.detail as unknown as string });
  },

  async onSearchCustomer() {
    const keyword = this.data.customerSearch.trim();
    if (!keyword) {
      wx.showToast({ title: '请输入搜索关键词', icon: 'none' });
      return;
    }
    this.setData({ loading: true });
    try {
      const results = await callStaffApi<CustomerSearchResult[]>('customer.search', { keyword });
      this.setData({ customerResults: results || [] });
      if (!results || results.length === 0) {
        wx.showToast({ title: '未找到该顾客', icon: 'none' });
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : '搜索失败';
      wx.showToast({ title: msg, icon: 'none' });
    } finally {
      this.setData({ loading: false });
    }
  },

  onCustomerTap(e: WechatMiniprogram.TouchEvent) {
    const idx = e.currentTarget.dataset.index as number;
    const customer = this.data.customerResults[idx];
    if (!customer) return;
    this.setData({
      selectedCustomer: customer,
      customerResults: [],
      customerSearch: '',
    });
    const userId = customer.clientUserId || customer.id;
    if (userId) {
      this.loadPaidOrders(userId);
    }
  },

  onClearCustomer() {
    this.setData({
      selectedCustomer: null,
      customerSearch: '',
      customerResults: [],
      paidItems: [],
      selectedItems: [],
      selectedFlowNos: {},
      selectedSessionCounts: {},
    });
  },

  async loadPaidOrders(clientUserId: string) {
    try {
      const orders = await callStaffApi<PaidOrder[]>('customer.paidOrders', { clientUserId });
      // 拍平成一维核销项目（按品项标签排序）：过滤家居产品行 + consumable<=0 的锁死卡（D6=A）
      // 可消费次数 = min(remaining, paid - used)；其中 used = total - remaining
      // NULL 卡（migration 0040 前未回填的历史卡）：保留但 disabled 灰显不可核销（Toast 拦截）
      const items: PaidOrderItem[] = [];
      for (const o of orders || []) {
        for (const i of o.items) {
          const total = Number(i.totalSessions || i.sessionCount || 0);
          const remain = Number(i.remainingSessions || 0);
          const isNullCard = i.paidSessions == null;
          const paid = isNullCard ? 0 : Number(i.paidSessions);
          const used = Math.max(total - remain, 0);
          const consumable = Math.max(0, Math.min(remain, paid - used));
          // 家居产品行剔除；NULL 卡（disabled）保留展示，其余 consumable<=0 的卡过滤
          if (i.productType === '家居产品') continue;
          if (consumable <= 0 && !isNullCard) continue;
          items.push({
            ...i,
            saleOrderId: o.saleOrderId,
            paidAt: formatDateTime(o.paidAt),
            consumableSessions: consumable,
            disabled: isNullCard,
            disabledReason: isNullCard ? '历史卡未回填,不可核销' : '',
            saleOrderTypeLabel: ORDER_TYPE_LABEL[o.saleOrderType || ''] || o.saleOrderType || '',
          });
        }
      }
      // 按品项标签归拢排序：主键 category（空排末尾），次键 paidAt DESC 兜底
      items.sort((a, b) => {
        const ca = a.category || '';
        const cb = b.category || '';
        if (ca !== cb) {
          if (!ca) return 1;
          if (!cb) return -1;
          return ca.localeCompare(cb, 'zh');
        }
        const pa = a.paidAt || '';
        const pb = b.paidAt || '';
        return (pa < pb) ? 1 : (pa > pb) ? -1 : 0;
      });
      this.setData({ paidItems: items });
    } catch (_) {}
  },

  onToggleItem(e: WechatMiniprogram.TouchEvent) {
    const { saleItemId, itemName, spec, saleOrderId, disabled } = e.currentTarget.dataset as {
      saleItemId: string; itemName: string; spec: string; saleOrderId: string; disabled?: boolean | string;
    };
    // NULL 历史卡：disabled 灰显，拦截核销并提示
    if (disabled === true || disabled === 'true') {
      wx.showToast({ title: '历史卡未回填,不可核销', icon: 'none' });
      return;
    }
    const selected = [...this.data.selectedItems];
    const idx = selected.findIndex(s => s.saleItemId === saleItemId);
    if (idx >= 0) {
      selected.splice(idx, 1);
    } else {
      selected.push({ saleItemId, itemName, spec, saleOrderId, sessionCount: 1 });
    }
    const flowNos: Record<string, boolean> = {};
    const sessionCounts: Record<string, number> = {};
    selected.forEach(s => { flowNos[s.saleItemId] = true; sessionCounts[s.saleItemId] = s.sessionCount; });
    this.setData({ selectedItems: selected, selectedFlowNos: flowNos, selectedSessionCounts: sessionCounts });
  },

  isItemSelected(flowNo: string): boolean {
    return this.data.selectedItems.some(s => s.saleItemId === flowNo);
  },

  onSessionStepperChange(e: WechatMiniprogram.CustomEvent) {
    const saleItemId = e.currentTarget.dataset.saleItemId as string;
    const value = e.detail as unknown as number;
    const selected = [...this.data.selectedItems];
    const idx = selected.findIndex(s => s.saleItemId === saleItemId);
    if (idx >= 0) {
      selected[idx] = { ...selected[idx], sessionCount: value };
      const sessionCounts = { ...this.data.selectedSessionCounts, [saleItemId]: value };
      this.setData({ selectedItems: selected, selectedSessionCounts: sessionCounts });
    }
  },

  preventBubble() {},

  onRemarkChange(e: WechatMiniprogram.CustomEvent) {
    this.setData({ remark: (e.detail as unknown as string) ?? '' });
  },

  // ===== 备注预设下拉（van-picker） =====
  onShowRemarkPicker() {
    this.setData({ showRemarkPicker: true });
  },

  onRemarkPickerClose() {
    this.setData({ showRemarkPicker: false });
  },

  onRemarkConfirm(e: WechatMiniprogram.CustomEvent) {
    const picked = e.detail.value as string;
    if (picked === DEPOSIT_REFUND_REMARK) {
      // 选预设：备注即标准化常量，隐藏自由文本框
      this.setData({ remarkMode: 'preset', remark: DEPOSIT_REFUND_REMARK, showRemarkPicker: false });
    } else {
      // 选自定义：清空备注、显示文本框照旧手填
      this.setData({ remarkMode: 'custom', remark: '', showRemarkPicker: false });
    }
  },

  async onSubmit() {
    if (this.data.submitting) return;
    const { selectedCustomer, selectedItems, appointmentId, staffName, remark } = this.data;

    if (!selectedCustomer) {
      wx.showToast({ title: '请先选择顾客', icon: 'none' });
      return;
    }
    if (selectedItems.length === 0) {
      wx.showToast({ title: '请选择至少一个核销项目', icon: 'none' });
      return;
    }

    this.setData({ submitting: true });
    try {
      await callStaffApi('service.create', {
        clientUserId: selectedCustomer.clientUserId || selectedCustomer.id,
        clientPhone: selectedCustomer.phone,
        appointmentId: appointmentId || null,
        assignedStaffWfId: this.data.assignedStaffWfId || undefined,
        items: selectedItems.map(i => ({
          saleItemId: i.saleItemId,
          sessionUsed: i.sessionCount,
        })),
        remark,
      });
      wx.showToast({ title: '服务单已创建', icon: 'success' });
      setTimeout(() => wx.navigateBack(), 1500);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : '提交失败';
      wx.showToast({ title: msg, icon: 'none' });
    } finally {
      this.setData({ submitting: false });
    }
  },

  onRemoveAppointment() {
    this.setData({ appointmentId: '', appointmentInfo: null });
  },

  // ===== 店长选择服务人员 =====
  async loadStaffList() {
    try {
      const data = await callStaffApi<{ staffList: Array<{ staffWfId: string; name: string; department: string; skills?: string[] }> }>('staff.list');
      const list = data?.staffList || [];
      const roleTag = (skills?: string[]) => (skills || []).filter(s => s === '美容师' || s === '养生师').join('/');
      this.setData({
        staffList: list,
        staffColumns: list.map(s => `${s.name}（${[roleTag(s.skills), s.department].filter(Boolean).join('·') || '未分组'}）`),
      });
    } catch (_) {}
  },

  onShowStaffPicker() {
    this.setData({ showStaffPicker: true });
  },

  onStaffPickerClose() {
    this.setData({ showStaffPicker: false });
  },

  onStaffConfirm(e: WechatMiniprogram.CustomEvent) {
    const pickedLabel = e.detail.value as string;
    const idx = this.data.staffColumns.indexOf(pickedLabel);
    const staff = this.data.staffList[idx];
    if (staff) {
      this.setData({
        assignedStaffWfId: staff.staffWfId,
        staffName: staff.name,
        showStaffPicker: false,
      });
    }
  },
});
