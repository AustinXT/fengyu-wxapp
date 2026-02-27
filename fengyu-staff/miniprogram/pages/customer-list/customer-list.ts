// pages/customer-list/customer-list.ts
import { callStaffApi } from '../../utils/cloud';

Page({
  data: {
    searchKeyword: '',
    results: [] as any[],
    loading: false,
    searched: false,
  },

  onSearchChange(e: WechatMiniprogram.CustomEvent) {
    this.setData({ searchKeyword: e.detail });
  },

  async onSearch() {
    const phone = this.data.searchKeyword.trim();
    if (!phone) return;
    this.setData({ loading: true, searched: true });
    try {
      const data = await callStaffApi<any[]>('customer.search', { phone });
      this.setData({ results: data || [] });
    } catch (err: any) {
      wx.showToast({ title: err.message || '搜索失败', icon: 'none' });
    } finally {
      this.setData({ loading: false });
    }
  },

  onItemTap(e: WechatMiniprogram.TouchEvent) {
    const id = e.currentTarget.dataset.id as string;
    wx.navigateTo({ url: `/pages/customer-detail/customer-detail?id=${id}` });
  },
});
