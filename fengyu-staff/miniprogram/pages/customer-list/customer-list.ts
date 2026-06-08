// pages/customer-list/customer-list.ts
import { callStaffApi } from '../../utils/cloud';
import { isManager } from '../../utils/role';
import { formatDate } from '../../utils/formatters';

// lastServiceDate 为后端原始 pg date（序列化成 UTC 串会偏移日期），统一格式化为 YYYY-MM-DD
function fmtCustomerDates<T extends { lastServiceDate: string | null }>(list: T[]): T[] {
  return list.map(c => ({ ...c, lastServiceDate: c.lastServiceDate ? formatDate(c.lastServiceDate) : c.lastServiceDate }));
}

type TagType = 'active' | 'atRisk' | 'lost' | 'sleeping' | 'birthday' | 'birthdayNext';

const app = getApp<IAppOption>();

interface StaffAction {
  name: string;
  employeeId: string;
}

// 顾客类型：'all' = 全部，其余为 customer_type 枚举字面量（须与 DB 一致）
type CustomerType = 'all' | '流量客' | '体验客' | '小美客' | '会员客';

// 拓展筛选选项（值须与 db/schema/enums.ts 字面量完全一致；空串 = 不筛选）
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
    // 顾客类型栏：全部 + customer_type 4 枚举值
    customerType: 'all' as CustomerType,
    // 拓展筛选维度（空串 = 不筛选）
    spendingTier: '',
    monthlyActivity: '',
    customerStatus: '',
    advancedExpanded: false,
    // 拓展筛选选项常量（供 wxml 渲染）
    customerTypeOptions: CUSTOMER_TYPE_OPTIONS,
    spendingTierOptions: SPENDING_TIER_OPTIONS,
    monthlyActivityOptions: MONTHLY_ACTIVITY_OPTIONS,
    customerStatusOptions: CUSTOMER_STATUS_OPTIONS,
    // 是否有任意拓展筛选激活（含顾客类型）
    hasAdvancedFilter: false,
    // 当前选中的标签（空 = 不筛选）
    activeTag: '' as '' | TagType,
    tagPage: 1,
    tagHasMore: false,
    // 客户分配
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

  // 是否存在任意拓展筛选（含顾客类型）激活
  computeHasAdvancedFilter(): boolean {
    const { customerType, spendingTier, monthlyActivity, customerStatus } = this.data;
    return customerType !== 'all' || !!spendingTier || !!monthlyActivity || !!customerStatus;
  },

  // 按当前筛选条件加载列表（无筛选时即默认全店列表）
  async loadFilteredList(): Promise<void> {
    this.setData({ loading: true, hasAdvancedFilter: this.computeHasAdvancedFilter() });
    try {
      const { customerType, spendingTier, monthlyActivity, customerStatus } = this.data;
      // profileScope: 顾客档案浏览，普通员工仅见绑定本人的顾客（业务流程选顾客不传此标记）
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

  // 展开/收起拓展筛选面板
  toggleAdvanced() {
    this.setData({ advancedExpanded: !this.data.advancedExpanded });
  },

  // 点击拓展筛选维度（顾客类型/消费档位/月度客活/到店状态），单选切换
  onAdvancedFilterTap(e: WechatMiniprogram.TouchEvent) {
    const { dim, value } = e.currentTarget.dataset as { dim: string; value: string };
    if ((this.data as Record<string, unknown>)[dim] === value) return;
    // 选拓展筛选清除统计卡片选中态（互斥）
    this.setData({ [dim]: value, activeTag: '', searchKeyword: '', searched: false });
    this.loadFilteredList();
  },

  // 重置全部拓展筛选（含顾客类型）
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

  // 点击统计卡片筛选
  onStatTap(e: WechatMiniprogram.TouchEvent) {
    const tag = e.currentTarget.dataset.tag as TagType;
    if (tag === this.data.activeTag) {
      // 取消筛选
      this.setData({ activeTag: '', searchKeyword: '' });
      this.loadFilteredList();
      return;
    }
    // 选卡片清除全部拓展筛选（互斥）
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

  // ===== 客户分配（仅店长，长按触发） =====
  async onLongPressAssign(e: WechatMiniprogram.TouchEvent) {
    const { clientUserId, name } = e.currentTarget.dataset;
    if (!clientUserId) return;

    // 懒加载员工列表
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
