// pages/order-create/order-create.ts — 开单
import { callStaffApi } from '../../utils/cloud';
import { isManager } from '../../utils/role';

const app = getApp<IAppOption>();

Page({
  data: {
    isManager: false,
    step: 1,
    searching: false,
    customerPhone: '',
    customerInfo: null as null | { id: string; name: string; phone: string; clientUserId?: string },
    orderType: 'normal' as 'normal' | 'experience' | 'promotion',
    orderItems: [] as Array<any>,
  },

  onShow() {
    this.setData({ isManager: isManager() });
  },

  onPhoneChange(e: WechatMiniprogram.CustomEvent) {
    this.setData({ customerPhone: e.detail, customerInfo: null });
  },

  onSelectOrderType(e: WechatMiniprogram.TouchEvent) {
    const type = e.currentTarget.dataset.type as 'normal' | 'experience' | 'promotion';
    this.setData({ orderType: type });
  },

  async onStep1Next() {
    const phone = this.data.customerPhone.trim();
    if (!phone || phone.length !== 11) {
      wx.showToast({ title: '请输入11位手机号', icon: 'none' });
      return;
    }
    this.setData({ searching: true });
    try {
      const data = await callStaffApi<{
        id: string;
        name: string;
        phone: string;
        clientUserId?: string;
      }>('customer.search', { phone });
      this.setData({ customerInfo: data, searching: false, step: 2 });
    } catch (err: any) {
      wx.showToast({ title: err.message || '查询失败', icon: 'none' });
      this.setData({ searching: false });
    }
  },

  onStep2Back() { this.setData({ step: 1 }); },
  onStep2Next() { this.setData({ step: 3 }); },
  onStep3Back() { this.setData({ step: 2 }); },
  onStep3Next() { this.setData({ step: 4 }); },
});
