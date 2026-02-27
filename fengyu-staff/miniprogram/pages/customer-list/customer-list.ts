// pages/customer-list/customer-list.ts
import { callStaffApi } from '../../utils/cloud';

Page({
  data: {
    searchKeyword: '',
    results: [] as any[],
    loading: false,
    searched: false,
  },

  onShow() {
    if (!this.data.searched) {
      this.loadDefaultList();
    }
  },

  async loadDefaultList() {
    this.setData({ loading: true });
    try {
      const data = await callStaffApi<any[]>('customer.search', {});
      this.setData({ results: data || [], searched: false });
    } catch (_) {
      this.setData({ results: [] });
    } finally {
      this.setData({ loading: false });
    }
  },

  onSearchChange(e: WechatMiniprogram.CustomEvent) {
    this.setData({ searchKeyword: e.detail });
    if (!e.detail.trim()) {
      this.loadDefaultList();
    }
  },

  async onSearch() {
    const keyword = this.data.searchKeyword.trim();
    if (!keyword) {
      this.loadDefaultList();
      return;
    }
    this.setData({ loading: true, searched: true });
    try {
      const data = await callStaffApi<any[]>('customer.search', { keyword });
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
