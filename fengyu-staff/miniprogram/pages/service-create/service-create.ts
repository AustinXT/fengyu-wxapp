// pages/service-create/service-create.ts — 创建服务单
import { callStaffApi } from '../../utils/cloud';

const app = getApp<IAppOption>();

interface PaidOrderItem {
  itemFlowNo: string;
  itemName: string;
  spec: string;
  sessionCount: number;
  remainingSessions: number;
  totalSessions: number;
  productType: string;
}

interface PaidOrder {
  orderId: string;
  orderNo: string;
  paidAt: string;
  items: PaidOrderItem[];
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
    selectedCustomer: null as null | { id: string; name: string; phone: string; clientUserId?: string },
    // 订单选择
    paidOrders: [] as PaidOrder[],
    selectedItems: [] as Array<{ itemFlowNo: string; itemName: string; spec: string; orderNo: string; sessionCount: number }>,
    selectedFlowNos: {} as Record<string, boolean>, // 预计算的选中 flowNo 集合，供 WXML 使用
    // 服务人员
    staffName: '',
    // 备注
    remark: '',
  },

  onLoad(options) {
    const { staffName } = app.globalData;
    this.setData({ staffName });

    if (options.preloaded === '1') {
      const preload = app.globalData._serviceCreatePreload;
      app.globalData._serviceCreatePreload = null;
      if (preload) {
        const selectedItems = preload.items.map(i => ({
          itemFlowNo: i.itemFlowNo,
          itemName: i.itemName,
          spec: i.spec,
          orderNo: i.orderNo,
          sessionCount: i.sessionCount,
        }));
        const flowNos: Record<string, boolean> = {};
        selectedItems.forEach(s => { flowNos[s.itemFlowNo] = true; });
        this.setData({
          selectedCustomer: preload.customer,
          selectedItems,
          selectedFlowNos: flowNos,
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
    }
  },

  async loadAppointmentInfo(id: string) {
    try {
      const data = await callStaffApi<any>('appointment.detail', { id });
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
    this.setData({ customerSearch: e.detail });
  },

  async onSearchCustomer() {
    const phone = this.data.customerSearch.trim();
    if (!phone || phone.length < 11) {
      wx.showToast({ title: '请输入完整手机号', icon: 'none' });
      return;
    }
    this.setData({ loading: true });
    try {
      const results = await callStaffApi<any[]>('customer.search', { phone });
      if (!results || results.length === 0) {
        wx.showToast({ title: '未找到该顾客', icon: 'none' });
        return;
      }
      const customer = results[0];
      this.setData({ selectedCustomer: customer });
      if (customer.clientUserId || customer.id) {
        this.loadPaidOrders(customer.clientUserId || customer.id);
      }
    } catch (err: any) {
      wx.showToast({ title: err.message || '搜索失败', icon: 'none' });
    } finally {
      this.setData({ loading: false });
    }
  },

  async loadPaidOrders(clientUserId: string) {
    try {
      const orders = await callStaffApi<PaidOrder[]>('customer.paidOrders', { clientUserId });
      // 过滤掉院装产品行
      const filtered = (orders || []).map(o => ({
        ...o,
        items: o.items.filter(i => i.productType !== '院装产品' && i.remainingSessions > 0),
      })).filter(o => o.items.length > 0);
      this.setData({ paidOrders: filtered });
    } catch (_) {}
  },

  onToggleItem(e: WechatMiniprogram.TouchEvent) {
    const { flowNo, itemName, spec, orderNo } = e.currentTarget.dataset as {
      flowNo: string; itemName: string; spec: string; orderNo: string;
    };
    const selected = [...this.data.selectedItems];
    const idx = selected.findIndex(s => s.itemFlowNo === flowNo);
    if (idx >= 0) {
      selected.splice(idx, 1);
    } else {
      selected.push({ itemFlowNo: flowNo, itemName, spec, orderNo, sessionCount: 1 });
    }
    const flowNos: Record<string, boolean> = {};
    selected.forEach(s => { flowNos[s.itemFlowNo] = true; });
    this.setData({ selectedItems: selected, selectedFlowNos: flowNos });
  },

  isItemSelected(flowNo: string): boolean {
    return this.data.selectedItems.some(s => s.itemFlowNo === flowNo);
  },

  onRemarkChange(e: WechatMiniprogram.CustomEvent) {
    this.setData({ remark: e.detail.value });
  },

  async onSubmit() {
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
        clientUserId: selectedCustomer.id,
        customerName: selectedCustomer.name,
        appointmentId: appointmentId || null,
        items: selectedItems.map(i => ({
          itemFlowNo: i.itemFlowNo,
          sessionCount: i.sessionCount,
        })),
        staffName,
        remark,
      });
      wx.showToast({ title: '服务单已创建', icon: 'success' });
      setTimeout(() => wx.navigateBack(), 1500);
    } catch (err: any) {
      wx.showToast({ title: err.message || '提交失败', icon: 'none' });
    } finally {
      this.setData({ submitting: false });
    }
  },

  onRemoveAppointment() {
    this.setData({ appointmentId: '', appointmentInfo: null });
  },
});
