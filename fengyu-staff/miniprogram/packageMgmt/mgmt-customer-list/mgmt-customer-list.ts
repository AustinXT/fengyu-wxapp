// packageMgmt/mgmt-customer-list — 管理层"顾客档案"列表子页
// scope 由 hub（mgmt-dashboard）通过路由参数透传，本页不再出 scope-picker
// 搜索框为空 = scope 内全部顾客分页（50/页），有 keyword = 关键字分页（50/页）
import { callStaffApi } from '../../utils/cloud';
import { canAccessManagement } from '../../utils/role';
import { MemberLevelBadgeData, withMemberLevelBadgeClasses } from '../../utils/member-level-badge';

type ScopeType = 'all' | 'market' | 'store';

interface CustomerListItem extends MemberLevelBadgeData {
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

interface CustomerSearchResponse {
  scope: { type: ScopeType; id: string | null; name: string };
  customers: CustomerListItem[];
  page: number;
  pageSize: number;
  hasMore: boolean;
}

interface ScopePayload {
  scopeType: ScopeType;
  scopeId: string | null;
}

const PAGE_SIZE = 50;

const SCOPE_TYPE_LABELS: Record<ScopeType, string> = {
  all: '全部市场',
  market: '市场',
  store: '门店',
};

Page({
  data: {
    scopeType: 'all' as ScopeType,
    scopeId: null as string | null,
    scopeName: '',
    scopeTypeLabel: '全部市场',

    searchKeyword: '',
    results: [] as CustomerListItem[],
    loading: false,
    searched: false,
    page: 1,
    hasMore: false,
    listError: false,
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
    if (this.data.results.length === 0 && !this.data.listError) {
      this.loadPage(1, true);
    }
  },

  onPullDownRefresh() {
    this.loadPage(1, true).finally(() => wx.stopPullDownRefresh());
  },

  onReachBottom() {
    if (!this.data.loading && this.data.hasMore) {
      this.loadPage(this.data.page + 1, false);
    }
  },

  scopePayload(): ScopePayload {
    return { scopeType: this.data.scopeType, scopeId: this.data.scopeId };
  },

  async loadPage(page: number, reset: boolean): Promise<void> {
    this.setData({ loading: true, listError: false });
    try {
      const keyword = this.data.searchKeyword.trim();
      const payload: Record<string, unknown> = {
        ...this.scopePayload(),
        page,
        pageSize: PAGE_SIZE,
      };
      if (keyword) payload.keyword = keyword;
      const data = await callStaffApi<CustomerSearchResponse>('mgmtCustomer.search', payload);
      const customers = withMemberLevelBadgeClasses(data.customers || []);
      const newResults = reset
        ? customers
        : [...this.data.results, ...customers];
      this.setData({
        results: newResults,
        page: data.page,
        hasMore: data.hasMore,
        searched: !!keyword,
      });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : '加载失败';
      wx.showToast({ title: msg, icon: 'none' });
      if (reset && this.data.results.length === 0) {
        this.setData({ listError: true });
      }
    } finally {
      this.setData({ loading: false });
    }
  },

  onListRetry() {
    this.loadPage(1, true);
  },

  onSearchChange(e: WechatMiniprogram.CustomEvent) {
    const value = e.detail as unknown as string;
    this.setData({ searchKeyword: value });
    if (!value.trim()) {
      // 关键字清空 → 重置回默认列表第一页
      this.loadPage(1, true);
    }
  },

  onSearch() {
    this.loadPage(1, true);
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
