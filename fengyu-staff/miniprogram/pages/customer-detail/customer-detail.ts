// pages/customer-detail/customer-detail.ts
import { callStaffApi } from '../../utils/cloud';
import { isManager } from '../../utils/role';

const app = getApp<IAppOption>();

interface TreatmentCard {
  itemFlowNo: string;
  itemName: string;
  spec: string;
  remainingSessions: number;
  totalSessions: number;
  orderNo: string;
  paidAt: string;
  selected: boolean;
  sessionCount: number;
}

Page({
  data: {
    loading: false,
    customer: null as any,
    treatmentCards: [] as TreatmentCard[],
    appointments: [] as any[],
    isManager: false,
    selectedCount: 0,
  },

  onLoad(options: Record<string, string>) {
    this.setData({ isManager: isManager() });
    if (options.id) {
      this.loadAll({ id: options.id });
    } else if (options.clientUserId) {
      this.loadAll({ clientUserId: options.clientUserId });
    }
  },

  async loadAll(query: { id?: string; clientUserId?: string }) {
    this.setData({ loading: true });
    try {
      const customer = await callStaffApi<any>('customer.detail', query);
      let orders: any[] = [];
      if (customer.clientUserId) {
        orders = await callStaffApi<any[]>('customer.paidOrders', { clientUserId: customer.clientUserId }) || [];
      } else if (customer.phone) {
        orders = await callStaffApi<any[]>('customer.paidOrders', { clientPhone: customer.phone }) || [];
      }
      // 扁平化：将按订单分组的 items 展开为独立卡片
      const treatmentCards: TreatmentCard[] = [];
      for (const order of orders) {
        for (const item of order.items) {
          if (item.remainingSessions > 0) {
            treatmentCards.push({
              itemFlowNo: item.itemFlowNo,
              itemName: item.itemName,
              spec: item.spec,
              remainingSessions: item.remainingSessions,
              totalSessions: item.totalSessions,
              orderNo: order.orderNo,
              paidAt: order.paidAt,
              selected: false,
              sessionCount: 1,
            });
          }
        }
      }
      this.setData({ customer, treatmentCards, selectedCount: 0 });
    } catch (err: any) {
      wx.showToast({ title: err.message || '加载失败', icon: 'none' });
    } finally {
      this.setData({ loading: false });
    }
  },

  onToggleCard(e: WechatMiniprogram.TouchEvent) {
    const index = e.currentTarget.dataset.index as number;
    const card = this.data.treatmentCards[index];
    const newSelected = !card.selected;
    const update: Record<string, any> = {
      [`treatmentCards[${index}].selected`]: newSelected,
    };
    if (!newSelected) {
      update[`treatmentCards[${index}].sessionCount`] = 1;
    }
    update.selectedCount = this.data.selectedCount + (newSelected ? 1 : -1);
    this.setData(update);
  },

  onStepperChange(e: WechatMiniprogram.CustomEvent) {
    const index = e.currentTarget.dataset.index as number;
    this.setData({ [`treatmentCards[${index}].sessionCount`]: e.detail });
  },

  preventBubble() {},

  onCreateService() {
    const { customer, treatmentCards } = this.data;
    if (!customer) return;

    const selected = treatmentCards.filter(c => c.selected);
    if (selected.length === 0) return;

    app.globalData._serviceCreatePreload = {
      customer: {
        id: customer.clientUserId || customer.id,
        name: customer.name,
        phone: customer.phone,
        clientUserId: customer.clientUserId,
      },
      items: selected.map(c => ({
        itemFlowNo: c.itemFlowNo,
        itemName: c.itemName,
        spec: c.spec,
        orderNo: c.orderNo,
        sessionCount: c.sessionCount,
        remainingSessions: c.remainingSessions,
      })),
    };

    wx.navigateTo({ url: '/pages/service-create/service-create?preloaded=1' });
  },

  onOrderTap(e: WechatMiniprogram.TouchEvent) {
    const id = e.currentTarget.dataset.id as string;
    wx.navigateTo({ url: `/pages/order-detail/order-detail?id=${id}` });
  },
});
