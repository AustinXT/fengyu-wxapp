// pages/service-create/service-create.ts — 创建服务单
import { callStaffApi } from '../../utils/cloud';
import { formatDateTime, ORDER_TYPE_LABEL } from '../../utils/formatters';
import { isManager } from '../../utils/role';
import { expandGroupServiceSessions, groupTreatmentCards, sumGroupValue } from '../../utils/treatment-card-group';

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
  unit?: string;
  storeId?: string;
  orderStoreId?: string;
  storeName?: string;
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
  saleOrderDatetime?: string | null;
  orderStatus?: string;
  saleOrderType?: string;
  documentType?: string | null;
  marketName?: string;
  legacySource?: string | null;
  /** 拍平后回填：支付时间（已格式化） */
  paidAt?: string;
  skuId?: string | null;
  itemDirection?: string;
  refSaleItemId?: string | null;
  /** 一级品项（product_categories.product_kind） */
  productKind?: string;
  /** 二级品项 ID（历史无分类卡为空） */
  categoryId?: string;
  /** 二级品项名称（保留 category 兼容字段） */
  categoryName?: string;
  quantity?: number;
  unitPrice?: string;
  saleAmount?: string;
  received?: string;
  pendingReceived?: string;
  expireDate?: string | null;
  remark?: string | null;
  salesCategory?: string | null;
  pickedUpQuantity?: number | null;
  groupKey?: string;
  cardCount?: number;
  sourceItems?: PaidOrderItem[];
}

interface SelectedPaidItem {
  saleItemId: string;
  itemName: string;
  spec: string;
  saleOrderId: string;
  sessionCount: number;
  unit: string;
  consumableSessions: number;
  cardCount: number;
  sourceItems: PaidOrderItem[];
}

interface CardFilterOption {
  value: string;
  label: string;
}

interface PaidOrder {
  orderId: string;
  saleOrderId: string;
  status: string;
  saleOrderDatetime?: string | null;
  paidAt: string;
  storeId?: string;
  storeName?: string;
  /** 单据类型（sale_orders.sale_order_type） */
  saleOrderType?: string;
  documentType?: string | null;
  marketName?: string;
  legacySource?: string | null;
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
    paidItemsLoaded: false,
    paidItemProductKind: '',
    paidItemCategoryId: '',
    paidItemNameQuery: '',
    paidItemProductKindOptions: [] as CardFilterOption[],
    paidItemCategoryOptions: [] as CardFilterOption[],
    paidItemProductKindLabel: '全部一级品项',
    paidItemCategoryLabel: '全部二级品项',
    hasPaidItemFilter: false,
    selectedItems: [] as SelectedPaidItem[],
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

  _allPaidItems: [] as PaidOrderItem[],
  _pendingPreloadedItems: [] as Array<{ saleItemId: string; sessionCount: number }>,

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
        this._pendingPreloadedItems = preload.items.map((item) => ({
          saleItemId: item.saleItemId,
          sessionCount: item.sessionCount,
        }));
        this.setData({
          selectedCustomer: preload.customer,
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
      // 服务单选顾客：需支持临时跨店顾客，故传 crossStore=true 放宽搜索范围
      // （后端返回 is_cross_store_temp 标记，前端凭此判断是否允许跨店核销）
      const results = await callStaffApi<CustomerSearchResult[]>('customer.search', { keyword, crossStore: true });
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
    this._allPaidItems = [];
    this._pendingPreloadedItems = [];
    this.setData({
      selectedCustomer: null,
      customerSearch: '',
      customerResults: [],
      paidItems: [],
      paidItemsLoaded: false,
      paidItemProductKind: '',
      paidItemCategoryId: '',
      paidItemNameQuery: '',
      paidItemProductKindOptions: [],
      paidItemCategoryOptions: [],
      paidItemProductKindLabel: '全部一级品项',
      paidItemCategoryLabel: '全部二级品项',
      hasPaidItemFilter: false,
      selectedItems: [],
      selectedFlowNos: {},
      selectedSessionCounts: {},
    });
  },

  async loadPaidOrders(clientUserId: string) {
    this._allPaidItems = [];
    this.setData({
      paidItems: [],
      paidItemsLoaded: false,
      paidItemProductKind: '',
      paidItemCategoryId: '',
      paidItemNameQuery: '',
      paidItemProductKindOptions: [],
      paidItemCategoryOptions: [],
      paidItemProductKindLabel: '全部一级品项',
      paidItemCategoryLabel: '全部二级品项',
      hasPaidItemFilter: false,
    });
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
            saleOrderDatetime: o.saleOrderDatetime,
            orderStatus: o.status,
            saleOrderType: o.saleOrderType,
            documentType: o.documentType,
            marketName: o.marketName,
            legacySource: o.legacySource,
            orderStoreId: o.storeId,
            storeName: o.storeName,
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
      const groupedItems = groupTreatmentCards(items, {
        getId: (item) => item.saleItemId,
        getQuantity: (item) => item.quantity,
        getIdentity: (item) => ({
          saleOrderId: item.saleOrderId,
          saleOrderDatetime: item.saleOrderDatetime,
          paidAt: item.paidAt,
          orderStatus: item.orderStatus,
          saleOrderType: item.saleOrderType,
          documentType: item.documentType,
          marketName: item.marketName,
          legacySource: item.legacySource,
          orderStoreId: item.orderStoreId,
          storeName: item.storeName,
          storeId: item.storeId,
          skuId: item.skuId,
          itemDirection: item.itemDirection,
          refSaleItemId: item.refSaleItemId,
          itemName: item.itemName,
          spec: item.spec,
          productType: item.productType,
          totalSessions: item.totalSessions,
          remainingSessions: item.remainingSessions,
          paidSessions: item.paidSessions,
          consumableSessions: item.consumableSessions,
          unit: item.unit,
          unitRealPrice: item.unitRealPrice,
          unitPrice: item.unitPrice,
          saleAmount: item.saleAmount,
          received: item.received,
          pendingReceived: item.pendingReceived,
          expireDate: item.expireDate,
          remark: item.remark,
          salesCategory: item.salesCategory,
          pickedUpQuantity: item.pickedUpQuantity,
          category: item.category,
          categoryColor: item.categoryColor,
          productKind: item.productKind,
          categoryId: item.categoryId,
          categoryName: item.categoryName,
          saleOrderTypeLabel: item.saleOrderTypeLabel,
          disabled: item.disabled,
          disabledReason: item.disabledReason,
          quantity: item.quantity ?? 1,
        }),
      }).map((group) => {
        const primary = group.primary;
        const totalSessions = sumGroupValue(group, (item) => item.totalSessions);
        const remainingSessions = sumGroupValue(group, (item) => item.remainingSessions);
        const paidSessions = primary.paidSessions === null
          ? null
          : sumGroupValue(group, (item) => item.paidSessions);
        return {
          ...primary,
          saleItemId: group.groupKey,
          groupKey: group.groupKey,
          sourceItems: group.sourceItems,
          cardCount: group.cardCount,
          quantity: sumGroupValue(group, (item) => item.quantity ?? 1),
          totalSessions,
          sessionCount: totalSessions,
          remainingSessions,
          paidSessions,
          consumableSessions: sumGroupValue(group, (item) => item.consumableSessions),
        };
      });
      this.applyPaidItemFilters(groupedItems, {
        productKind: '',
        categoryId: '',
        nameQuery: '',
      });
      if (this._pendingPreloadedItems.length > 0) {
        const selectedItems: SelectedPaidItem[] = groupedItems.flatMap((group) => {
          const matched = this._pendingPreloadedItems.filter((pending) =>
            (group.sourceItems || [group]).some((source) => source.saleItemId === pending.saleItemId),
          );
          if (matched.length === 0) return [];
          const sessionCount = matched.reduce((total, pending) => total + pending.sessionCount, 0);
          return [{
            saleItemId: group.saleItemId,
            itemName: group.itemName,
            spec: group.spec,
            saleOrderId: group.saleOrderId || '',
            sessionCount: Math.max(1, Math.min(sessionCount, group.consumableSessions)),
            unit: group.unit || '次',
            consumableSessions: group.consumableSessions,
            cardCount: group.cardCount || 1,
            sourceItems: group.sourceItems || [group],
          }];
        });
        const flowNos: Record<string, boolean> = {};
        const sessionCounts: Record<string, number> = {};
        selectedItems.forEach((item) => {
          flowNos[item.saleItemId] = true;
          sessionCounts[item.saleItemId] = item.sessionCount;
        });
        this.setData({ selectedItems, selectedFlowNos: flowNos, selectedSessionCounts: sessionCounts });
        this._pendingPreloadedItems = [];
      }
      this.setData({ paidItemsLoaded: true });
    } catch (_) {
      this.setData({ paidItemsLoaded: true });
    }
  },

  applyPaidItemFilters(
    this: any,
    items: PaidOrderItem[] = this._allPaidItems,
    filters: { productKind?: string; categoryId?: string; nameQuery?: string } = {},
  ) {
    this._allPaidItems = items;
    const productKind = filters.productKind ?? this.data.paidItemProductKind;
    const categoryId = filters.categoryId ?? this.data.paidItemCategoryId;
    const nameQuery = filters.nameQuery ?? this.data.paidItemNameQuery;
    const productKindOptions: CardFilterOption[] = [
      { value: '', label: '全部一级品项' },
      ...Array.from(new Set(items.map((item) => item.productKind).filter((value): value is string => Boolean(value))))
        .map((value) => ({ value, label: value })),
    ];
    const categoryOptions: CardFilterOption[] = [
      { value: '', label: productKind ? '全部二级品项' : '请先选择一级品项' },
      ...Array.from(
        new Map(
          items
            .filter((item) => item.categoryId && item.categoryName && productKind && item.productKind === productKind)
            .map((item) => [item.categoryId!, { value: item.categoryId!, label: item.categoryName! }]),
        ).values(),
      ),
    ];
    const query = nameQuery.trim().toLocaleLowerCase();
    const paidItems = items.filter((item) => {
      if (productKind && item.productKind !== productKind) return false;
      if (categoryId && item.categoryId !== categoryId) return false;
      return !query || item.itemName.toLocaleLowerCase().includes(query);
    });
    this.setData({
      paidItems,
      paidItemProductKind: productKind,
      paidItemCategoryId: categoryId,
      paidItemNameQuery: nameQuery,
      paidItemProductKindOptions: productKindOptions,
      paidItemCategoryOptions: categoryOptions,
      paidItemProductKindLabel: productKind || '全部一级品项',
      paidItemCategoryLabel: categoryOptions.find((option) => option.value === categoryId)?.label || categoryOptions[0].label,
      hasPaidItemFilter: Boolean(productKind || categoryId || nameQuery),
    });
  },

  onPaidItemProductKindChange(e: WechatMiniprogram.CustomEvent) {
    const index = Number(e.detail.value);
    const productKind = this.data.paidItemProductKindOptions[index]?.value || '';
    this.applyPaidItemFilters(this._allPaidItems, {
      productKind,
      categoryId: '',
      nameQuery: this.data.paidItemNameQuery,
    });
  },

  onPaidItemCategoryChange(e: WechatMiniprogram.CustomEvent) {
    const index = Number(e.detail.value);
    const categoryId = this.data.paidItemCategoryOptions[index]?.value || '';
    this.applyPaidItemFilters(this._allPaidItems, { categoryId });
  },

  onPaidItemNameChange(e: WechatMiniprogram.CustomEvent) {
    const detail = e.detail as unknown as string | { value?: string };
    const nameQuery = typeof detail === 'string' ? detail : detail?.value || '';
    this.applyPaidItemFilters(this._allPaidItems, { nameQuery });
  },

  onToggleItem(e: WechatMiniprogram.TouchEvent) {
    const { saleItemId, disabled } = e.currentTarget.dataset as {
      saleItemId: string; disabled?: boolean | string;
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
      const paidItem = this._allPaidItems.find(item => item.saleItemId === saleItemId);
      if (!paidItem) return;
      selected.push({
        saleItemId,
        itemName: paidItem.itemName,
        spec: paidItem.spec,
        saleOrderId: paidItem.saleOrderId || '',
        sessionCount: 1,
        unit: paidItem.unit || '次',
        consumableSessions: paidItem.consumableSessions,
        cardCount: paidItem.cardCount || 1,
        sourceItems: paidItem.sourceItems || [paidItem],
      });
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
      const max = Math.max(1, selected[idx].consumableSessions);
      const sessionCount = Math.max(1, Math.min(Number(value) || 1, max));
      selected[idx] = { ...selected[idx], sessionCount };
      const sessionCounts = { ...this.data.selectedSessionCounts, [saleItemId]: sessionCount };
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
      const expandedItems = selectedItems.flatMap((item) => {
        const primary = item.sourceItems[0];
        if (!primary) return [];
        return expandGroupServiceSessions(
          {
            groupKey: item.saleItemId,
            primary,
            sourceItems: item.sourceItems,
            cardCount: item.cardCount,
          },
          item.sessionCount,
          (source) => source.saleItemId,
          (source) => source.consumableSessions,
        );
      });
      if (expandedItems.length === 0) {
        throw new Error('请选择可核销的疗程卡');
      }
      await callStaffApi('service.create', {
        clientUserId: selectedCustomer.clientUserId || selectedCustomer.id,
        clientPhone: selectedCustomer.phone,
        appointmentId: appointmentId || null,
        assignedStaffWfId: this.data.assignedStaffWfId || undefined,
        items: expandedItems,
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
