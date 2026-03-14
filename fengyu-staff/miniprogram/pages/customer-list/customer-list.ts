// pages/customer-list/customer-list.ts
import { callStaffApi } from '../../utils/cloud';

type TagType = 'active' | 'atRisk' | 'lost' | 'sleeping' | 'birthday' | 'birthdayNext';

Page({
  data: {
    searchKeyword: '',
    results: [] as any[],
    loading: false,
    searched: false,
    // 统计数据
    stats: {
      active: 0,
      atRisk: 0,
      lost: 0,
      sleeping: 0,
      birthday: 0,
      birthdayNext: 0,
      total: 0,
    },
    // 当前选中的标签（空 = 不筛选）
    activeTag: '' as '' | TagType,
    tagPage: 1,
    tagHasMore: false,
  },

  onShow() {
    this.loadStats();
    if (!this.data.activeTag && !this.data.searched) {
      this.loadDefaultList();
    }
  },

  async loadStats() {
    try {
      const stats = await callStaffApi<any>('customer.stats');
      this.setData({ stats });
    } catch (_) {}
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
    this.setData({ searchKeyword: e.detail as unknown as string });
    if (!e.detail.trim()) {
      this.setData({ activeTag: '' });
      this.loadDefaultList();
    }
  },

  async onSearch() {
    const keyword = this.data.searchKeyword.trim();
    if (!keyword) {
      this.loadDefaultList();
      return;
    }
    this.setData({ loading: true, searched: true, activeTag: '' });
    try {
      const data = await callStaffApi<any[]>('customer.search', { keyword });
      this.setData({ results: data || [] });
    } catch (err: any) {
      wx.showToast({ title: err.message || '搜索失败', icon: 'none' });
    } finally {
      this.setData({ loading: false });
    }
  },

  // 点击统计卡片筛选
  onStatTap(e: WechatMiniprogram.TouchEvent) {
    const tag = e.currentTarget.dataset.tag as TagType;
    if (tag === this.data.activeTag) {
      // 取消筛选
      this.setData({ activeTag: '', searchKeyword: '' });
      this.loadDefaultList();
      return;
    }
    this.setData({ activeTag: tag, searchKeyword: '', searched: false, tagPage: 1 });
    this.loadByTag(tag, 1, true);
  },

  async loadByTag(tag: TagType, page: number, reset: boolean) {
    this.setData({ loading: true });
    try {
      const data = await callStaffApi<any>('customer.listByTag', { tag, page, pageSize: 20 });
      const newResults = reset ? (data.customers || []) : [...this.data.results, ...(data.customers || [])];
      this.setData({
        results: newResults,
        tagPage: page,
        tagHasMore: newResults.length < data.total,
      });
    } catch (err: any) {
      wx.showToast({ title: err.message || '加载失败', icon: 'none' });
    } finally {
      this.setData({ loading: false });
    }
  },

  onReachBottom() {
    if (this.data.activeTag && this.data.tagHasMore && !this.data.loading) {
      this.loadByTag(this.data.activeTag as TagType, this.data.tagPage + 1, false);
    }
  },

  onItemTap(e: WechatMiniprogram.TouchEvent) {
    const { id, clientUserId } = e.currentTarget.dataset;
    const params = id ? `id=${id}` : `clientUserId=${clientUserId}`;
    wx.navigateTo({ url: `/packageCustomer/customer-detail/customer-detail?${params}` });
  },
});
