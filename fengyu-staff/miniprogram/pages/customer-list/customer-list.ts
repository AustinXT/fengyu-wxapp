
import { callStaffApi } from '../../utils/cloud';
import { isManager } from '../../utils/role';
import { formatDate } from '../../utils/formatters';


function fmtCustomerDates<T extends { lastServiceDate: string | null }>(list: T[]): T[] {
  return list.map(c => ({ ...c, lastServiceDate: c.lastServiceDate ? formatDate(c.lastServiceDate) : c.lastServiceDate }));
}

type TagType = 'active' | 'atRisk' | 'lost' | 'sleeping' | 'birthday' | 'birthdayNext';

const app = getApp<IAppOption>();

interface StaffAction {
  name: string;
  employeeId: string;
}


type CustomerType = 'all' | '流量客' | '体验客' | '小美客' | '会员客';


const CUSTOMER_TYPE_OPTIONS = [
  { label: '全部', value: 'all' },
  { label: '流量客', value: '流量客' },
  { label: '体验客', value: '体验客' },
  { label: '小美客', value: '小美客' },
  { label: '会员客', value: '会员客' },
];
const SPENDING_TIER_OPTIONS = [
  { label: '全部', value: '' },
  { label: '10W+', value: '10W+' },
  { label: '6-10W', value: '6-10W' },
  { label: '3-6W', value: '3-6W' },
  { label: '1-3W', value: '1-3W' },
  { label: '1990-1W', value: '1990-1W' },
  { label: '<1990', value: '<1990' },
];
const MONTHLY_ACTIVITY_OPTIONS = [
  { label: '全部', value: '' },
  { label: '二次客活', value: '二次客活' },
  { label: '一次客活', value: '一次客活' },
  { label: '0次客活', value: '0次客活' },
];
const CUSTOMER_STATUS_OPTIONS = [
  { label: '全部', value: '' },
  { label: '保有会员-稳定', value: '保有会员-稳定' },
  { label: '保有会员-有效', value: '保有会员-有效' },
  { label: '沉睡', value: '沉睡' },
  { label: '冰冻', value: '冰冻' },
  { label: '休眠', value: '休眠' },
];

interface CustomerListItem {
  id: string | null;
  clientUserId: string | null;
  name: string;
  phone: string;
  phoneMasked: string;
  memberLevel: string | null;
  storeName: string;
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

Page({
  data: {
    searchKeyword: '',
    results: [] as CustomerListItem[],
    loading: false,
    searched: false,
    
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
    
    customerType: 'all' as CustomerType,
    
    spendingTier: '',
    monthlyActivity: '',
    customerStatus: '',
    advancedExpanded: false,
    
    customerTypeOptions: CUSTOMER_TYPE_OPTIONS,
    spendingTierOptions: SPENDING_TIER_OPTIONS,
    monthlyActivityOptions: MONTHLY_ACTIVITY_OPTIONS,
    customerStatusOptions: CUSTOMER_STATUS_OPTIONS,
    
    hasAdvancedFilter: false,
    
    activeTag: '' as '' | TagType,
    tagPage: 1,
    tagHasMore: false,
    
    isManager: false,
    showAssignSheet: false,
    staffActions: [] as StaffAction[],
    assignTarget: { clientUserId: '', name: '' },
  },

  onShow() {
    if (!app.globalData.staffWfId) {
      wx.reLaunch({ url: '/pages/login/login' });
      return;
    }
    this.setData({ isManager: isManager() });
    this.loadStats();
    if (!this.data.activeTag && !this.data.searched) {
      this.loadFilteredList();
    }
  },

  onPullDownRefresh() {
    const done = () => wx.stopPullDownRefresh();
    this.loadStats();
    if (this.data.activeTag) {
      this.loadByTag(this.data.activeTag as TagType, 1, true).finally(done);
    } else {
      this.loadFilteredList().finally(done);
    }
  },

  async loadStats() {
    try {
      const stats = await callStaffApi<CustomerStatsResponse>('customer.stats');
      this.setData({ stats });
    } catch (_) {}
  },

  
  computeHasAdvancedFilter(): boolean {
    const { customerType, spendingTier, monthlyActivity, customerStatus } = this.data;
    return customerType !== 'all' || !!spendingTier || !!monthlyActivity || !!customerStatus;
  },

  
  async loadFilteredList(): Promise<void> {
    this.setData({ loading: true, hasAdvancedFilter: this.computeHasAdvancedFilter() });
    try {
      const { customerType, spendingTier, monthlyActivity, customerStatus } = this.data;
      
      const params: Record<string, string | boolean> = { profileScope: true };
      if (customerType !== 'all') params.customerType = customerType;
      if (spendingTier) params.spendingTier = spendingTier;
      if (monthlyActivity) params.monthlyActivity = monthlyActivity;
      if (customerStatus) params.customerStatus = customerStatus;
      const data = await callStaffApi<CustomerListItem[]>('customer.search', params);
      this.setData({ results: fmtCustomerDates(data || []), searched: false });
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
      this.loadFilteredList();
    }
  },

  async onSearch() {
    const keyword = this.data.searchKeyword.trim();
    if (!keyword) {
      this.loadFilteredList();
      return;
    }
    this.setData({ loading: true, searched: true, activeTag: '' });
    try {
      const data = await callStaffApi<CustomerListItem[]>('customer.search', { keyword, profileScope: true });
      this.setData({ results: fmtCustomerDates(data || []) });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : '搜索失败';
      wx.showToast({ title: msg, icon: 'none' });
    } finally {
      this.setData({ loading: false });
    }
  },

  
  toggleAdvanced() {
    this.setData({ advancedExpanded: !this.data.advancedExpanded });
  },

  
  onAdvancedFilterTap(e: WechatMiniprogram.TouchEvent) {
    const { dim, value } = e.currentTarget.dataset as { dim: string; value: string };
    if ((this.data as Record<string, unknown>)[dim] === value) return;
    
    this.setData({ [dim]: value, activeTag: '', searchKeyword: '', searched: false });
    this.loadFilteredList();
  },

  
  onResetFilters() {
    this.setData({
      customerType: 'all',
      spendingTier: '',
      monthlyActivity: '',
      customerStatus: '',
      activeTag: '',
      searchKeyword: '',
      searched: false,
    });
    this.loadFilteredList();
  },

  
  onStatTap(e: WechatMiniprogram.TouchEvent) {
    const tag = e.currentTarget.dataset.tag as TagType;
    if (tag === this.data.activeTag) {
      
      this.setData({ activeTag: '', searchKeyword: '' });
      this.loadFilteredList();
      return;
    }
    
    this.setData({
      activeTag: tag,
      customerType: 'all',
      spendingTier: '',
      monthlyActivity: '',
      customerStatus: '',
      hasAdvancedFilter: false,
      searchKeyword: '',
      searched: false,
      tagPage: 1,
    });
    this.loadByTag(tag, 1, true);
  },

  async loadByTag(tag: TagType, page: number, reset: boolean) {
    this.setData({ loading: true });
    try {
      const data = await callStaffApi<CustomerTagResponse>('customer.listByTag', { tag, page, pageSize: 20 });
      const newResults = reset ? fmtCustomerDates(data.customers || []) : [...this.data.results, ...fmtCustomerDates(data.customers || [])];
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

  
  async onLongPressAssign(e: WechatMiniprogram.TouchEvent) {
    const { clientUserId, name } = e.currentTarget.dataset;
    if (!clientUserId) return;

    
    if (this.data.staffActions.length === 0) {
      try {
        const staff = await callStaffApi<Array<{ employeeId: string; name: string }>>('staff.list');
        this.setData({
          staffActions: (staff || []).map(s => ({ name: s.name, employeeId: s.employeeId })),
        });
      } catch (_) {
        wx.showToast({ title: '获取员工列表失败', icon: 'none' });
        return;
      }
    }

    this.setData({
      assignTarget: { clientUserId, name: name || '该顾客' },
      showAssignSheet: true,
    });
  },

  onAssignClose() {
    this.setData({ showAssignSheet: false });
  },

  async onAssignSelect(e: WechatMiniprogram.CustomEvent) {
    const action = e.detail as StaffAction;
    this.setData({ showAssignSheet: false });
    try {
      const result = await callStaffApi<{ message: string; employeeName: string }>(
        'customer.assign',
        { clientUserId: this.data.assignTarget.clientUserId, employeeId: action.employeeId },
      );
      wx.showToast({ title: `已分配给${result.employeeName}`, icon: 'success' });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : '分配失败';
      wx.showToast({ title: msg, icon: 'none' });
    }
  },
});
