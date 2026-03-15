// pages/customer-list/customer-list.ts
import { callStaffApi } from '../../utils/cloud';

type TagType = 'active' | 'atRisk' | 'lost' | 'sleeping' | 'birthday' | 'birthdayNext';

const app = getApp<IAppOption>();

type CustomerType = 'all' | 'member' | 'flow';

interface CustomerListItem {
  id: string | null;
  clientUserId: string | null;
  name: string;
  phone: string;
  phoneMasked: string;
  memberLevel: string | null;
  storeName: string;
  tier: 'diamond' | 'iron' | 'fan' | null;
  lastServiceDate: string | null;
  source: string;
}

interface CustomerStatsResponse {
  active: number;
  atRisk: number;
  lost: number;
  sleeping: number;
  birthday: number;
  birthdayNext: number;
  total: number;
  memberCount: number;
  flowCount: number;
}

interface CustomerTagResponse {
  customers: CustomerListItem[];
  total: number;
}

Page({
  data: {
    searchKeyword: '',
    results: [] as CustomerListItem[],
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
      memberCount: 0,
      flowCount: 0,
    },
    // 统计栏：全部/会员客/流量客
    customerType: 'all' as CustomerType,
    // 当前选中的标签（空 = 不筛选）
    activeTag: '' as '' | TagType,
    tagPage: 1,
    tagHasMore: false,
  },

  onShow() {
    if (!app.globalData.staffWfId) {
      wx.reLaunch({ url: '/pages/login/login' });
      return;
    }
    this.loadStats();
    if (!this.data.activeTag && !this.data.searched) {
      this.loadDefaultList();
    }
  },

  onPullDownRefresh() {
    const done = () => wx.stopPullDownRefresh();
    this.loadStats();
    if (this.data.activeTag) {
      this.loadByTag(this.data.activeTag as TagType, 1, true).finally(done);
    } else {
      this.loadDefaultList().finally(done);
    }
  },

  async loadStats() {
    try {
      const stats = await callStaffApi<CustomerStatsResponse>('customer.stats');
      this.setData({ stats });
    } catch (_) {}
  },

  async loadDefaultList(): Promise<void> {
    this.setData({ loading: true });
    try {
      const { customerType } = this.data;
      const params: Record<string, string> = {};
      if (customerType !== 'all') params.customerType = customerType;
      const data = await callStaffApi<CustomerListItem[]>('customer.search', params);
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
      const data = await callStaffApi<CustomerListItem[]>('customer.search', { keyword });
      this.setData({ results: data || [] });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : '搜索失败';
      wx.showToast({ title: msg, icon: 'none' });
    } finally {
      this.setData({ loading: false });
    }
  },

  // 切换统计栏：全部/会员客/流量客
  onCustomerTypeTap(e: WechatMiniprogram.TouchEvent) {
    const type = e.currentTarget.dataset.type as CustomerType;
    if (type === this.data.customerType) return;
    this.setData({ customerType: type, activeTag: '', searchKeyword: '', searched: false });
    this.loadDefaultList();
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
    this.setData({ activeTag: tag, customerType: 'all', searchKeyword: '', searched: false, tagPage: 1 });
    this.loadByTag(tag, 1, true);
  },

  async loadByTag(tag: TagType, page: number, reset: boolean) {
    this.setData({ loading: true });
    try {
      const data = await callStaffApi<CustomerTagResponse>('customer.listByTag', { tag, page, pageSize: 20 });
      const newResults = reset ? (data.customers || []) : [...this.data.results, ...(data.customers || [])];
      this.setData({
        results: newResults,
        tagPage: page,
        tagHasMore: newResults.length < data.total,
      });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : '加载失败';
      wx.showToast({ title: msg, icon: 'none' });
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
