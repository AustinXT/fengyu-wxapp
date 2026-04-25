// packageMgmt/mgmt-customer-list — 管理层"顾客档案"列表子页
// scope 由 hub（mgmt-dashboard）通过路由参数透传，本页不再出 scope-picker
// 移除门店视图的客户分配（长按 + action-sheet），纯只读列表
import { callStaffApi } from '../../utils/cloud';
import { canAccessManagement } from '../../utils/role';

type TagType = 'active' | 'atRisk' | 'lost' | 'sleeping' | 'birthday' | 'birthdayNext';

type ScopeType = 'all' | 'market' | 'store';

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
  lastPurchaseName: string | null;
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

interface ScopePayload {
  scopeType: ScopeType;
  scopeId: string | null;
}

const SCOPE_TYPE_LABELS: Record<ScopeType, string> = {
  all: '全部市场',
  market: '市场',
  store: '门店',
};

Page({
  data: {
    // scope
    scopeType: 'all' as ScopeType,
    scopeId: null as string | null,
    scopeName: '',
    scopeTypeLabel: '全部市场',

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
    } as CustomerStatsResponse,
    // 统计栏：全部/会员客/流量客
    customerType: 'all' as CustomerType,
    // 当前选中的标签（空 = 不筛选）
    activeTag: '' as '' | TagType,
    tagPage: 1,
    tagHasMore: false,
  },

  onLoad(query: { scopeType?: string; scopeId?: string; scopeName?: string }) {
    const scopeType = ((query?.scopeType as ScopeType) || 'all') as ScopeType;
    const scopeId = query?.scopeId ? decodeURIComponent(query.scopeId) : null;
    const scopeName = query?.scopeName ? decodeURIComponent(query.scopeName) : '';
    this.setData({
      scopeType,
      scopeId,
      scopeName,
      scopeTypeLabel: SCOPE_TYPE_LABELS[scopeType] || '全部市场',
    });
  },

  onShow() {
    if (!canAccessManagement()) {
      wx.reLaunch({ url: '/pages/workbench/workbench' });
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

  scopePayload(): ScopePayload {
    return { scopeType: this.data.scopeType, scopeId: this.data.scopeId };
  },

  async loadStats() {
    try {
      const stats = await callStaffApi<CustomerStatsResponse>('mgmtCustomer.stats', {
        ...this.scopePayload(),
      });
      this.setData({ stats });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : '统计加载失败';
      wx.showToast({ title: msg, icon: 'none' });
    }
  },

  async loadDefaultList(): Promise<void> {
    this.setData({ loading: true });
    try {
      const { customerType } = this.data;
      const payload: Record<string, unknown> = { ...this.scopePayload() };
      if (customerType !== 'all') payload.customerType = customerType;
      const data = await callStaffApi<CustomerListItem[]>('mgmtCustomer.search', payload);
      this.setData({ results: data || [], searched: false });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : '加载失败';
      wx.showToast({ title: msg, icon: 'none' });
      // 保留旧 results 防闪屏
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
      const data = await callStaffApi<CustomerListItem[]>('mgmtCustomer.search', {
        ...this.scopePayload(),
        keyword,
      });
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
      const data = await callStaffApi<CustomerTagResponse>('mgmtCustomer.listByTag', {
        ...this.scopePayload(),
        tag,
        page,
        pageSize: 20,
      });
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
    const { clientUserId } = e.currentTarget.dataset as { clientUserId?: string };
    if (!clientUserId) return;
    const { scopeType, scopeId, scopeName } = this.data;
    const params = [
      `clientUserId=${encodeURIComponent(clientUserId)}`,
      `scopeType=${encodeURIComponent(scopeType)}`,
      `scopeId=${encodeURIComponent(scopeId || '')}`,
      `scopeName=${encodeURIComponent(scopeName || '')}`,
    ].join('&');
    wx.navigateTo({ url: `/packageMgmt/mgmt-customer-detail/mgmt-customer-detail?${params}` });
  },
});
