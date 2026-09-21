// pages/customer-list/customer-list.ts
import { callStaffApi } from '../../utils/cloud';
import { isManager } from '../../utils/role';
import { formatDate } from '../../utils/formatters';
import { MemberLevelBadgeData, withMemberLevelBadgeClasses } from '../../utils/member-level-badge';

// lastServiceDate 为后端原始 pg date（序列化成 UTC 串会偏移日期），统一格式化为 YYYY-MM-DD
function fmtCustomerDates<T extends { lastServiceDate: string | null }>(list: T[]): T[] {
  return list.map(c => ({ ...c, lastServiceDate: c.lastServiceDate ? formatDate(c.lastServiceDate) : c.lastServiceDate }));
}

type TagType = 'active' | 'atRisk' | 'lost' | 'sleeping' | 'birthday' | 'birthdayNext';

const app = getApp<IAppOption>();

interface StaffAction {
  name: string;
  staffWfId: string;
}

interface StaffListResponse {
  staffList: Array<{
    staffWfId: string;
    name: string;
  }>;
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

interface CustomerListItem extends MemberLevelBadgeData {
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

// customer.search 带 page 时的分页信封（不带 page 仍返回裸数组，业务流程选顾客沿用）
interface CustomerSearchPage {
  customers: CustomerListItem[];
  page: number;
  pageSize: number;
  hasMore: boolean;
}

// 与 customer.listByTag 及管理层顾客列表保持同一页大小
const PAGE_SIZE = 20;

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
    // 分页状态（#181）：标签分支与搜索/筛选分支共用，onReachBottom 单一判据
    page: 1,
    hasMore: false,
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
      this.loadList(1, true);
    }
  },

  onPullDownRefresh() {
    const done = () => wx.stopPullDownRefresh();
    this.loadStats();
    if (this.data.activeTag) {
      this.loadByTag(this.data.activeTag as TagType, 1, true).finally(done);
    } else {
      this.loadList(1, true).finally(done);
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

  // 按当前筛选条件 + 关键词加载列表（无筛选无关键词时即默认全店列表）
  // #181：原 loadFilteredList / onSearch 两个无分页函数合并于此，分页逻辑只写一遍。
  // 关键词与拓展筛选**同时**下发 —— 改造前 onSearch 只传 keyword，筛选条在 UI 上仍高亮
  // 却不作用于结果，属于 UI 与请求不一致；合并后以 UI 所见为准。
  async loadList(page: number, reset: boolean): Promise<void> {
    this.setData({ loading: true, hasAdvancedFilter: this.computeHasAdvancedFilter() });
    try {
      const { customerType, spendingTier, monthlyActivity, customerStatus } = this.data;
      const keyword = this.data.searchKeyword.trim();
      // profileScope: 顾客档案浏览，普通员工仅见绑定本人的顾客（业务流程选顾客不传此标记）
      const params: Record<string, string | number | boolean> = {
        profileScope: true,
        page,
        pageSize: PAGE_SIZE,
      };
      if (keyword) params.keyword = keyword;
      if (customerType !== 'all') params.customerType = customerType;
      if (spendingTier) params.spendingTier = spendingTier;
      if (monthlyActivity) params.monthlyActivity = monthlyActivity;
      if (customerStatus) params.customerStatus = customerStatus;
      // 带 page 时云函数返回分页信封（不带则是裸数组，供业务流程选顾客沿用）
      const data = await callStaffApi<CustomerSearchPage>('customer.search', params);
      const customers = withMemberLevelBadgeClasses(fmtCustomerDates(data.customers || []));
      const newResults = reset ? customers : [...this.data.results, ...customers];
      this.setData({
        results: newResults,
        page: data.page,
        hasMore: data.hasMore,
        searched: !!keyword,
      });
    } catch (err: unknown) {
      // 首屏失败清空列表（沿用既有静默口径）；翻页失败保留已有结果并提示
      if (reset) {
        this.setData({ results: [], page: 1, hasMore: false });
      } else {
        const msg = err instanceof Error ? err.message : '加载失败';
        wx.showToast({ title: msg, icon: 'none' });
      }
    } finally {
      this.setData({ loading: false });
    }
  },

  onSearchChange(e: WechatMiniprogram.CustomEvent) {
    this.setData({ searchKeyword: e.detail as unknown as string });
    if (!e.detail.trim()) {
      this.setData({ activeTag: '' });
      this.loadList(1, true);
    }
  },

  async onSearch() {
    // 搜索与筛选互斥于标签筛选：清标签后统一交给 loadList（关键词为空即退回默认列表）
    this.setData({ activeTag: '' });
    await this.loadList(1, true);
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
    this.loadList(1, true);
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
    this.loadList(1, true);
  },

  // 点击统计卡片筛选
  onStatTap(e: WechatMiniprogram.TouchEvent) {
    const tag = e.currentTarget.dataset.tag as TagType;
    if (tag === this.data.activeTag) {
      // 取消筛选
      this.setData({ activeTag: '', searchKeyword: '' });
      this.loadList(1, true);
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
      page: 1,
    });
    this.loadByTag(tag, 1, true);
  },

  async loadByTag(tag: TagType, page: number, reset: boolean) {
    this.setData({ loading: true });
    try {
      const data = await callStaffApi<CustomerTagResponse>('customer.listByTag', { tag, page, pageSize: PAGE_SIZE });
      const customers = withMemberLevelBadgeClasses(fmtCustomerDates(data.customers || []));
      const newResults = reset ? customers : [...this.data.results, ...customers];
      this.setData({
        results: newResults,
        page,
        hasMore: newResults.length < data.total,
      });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : '加载失败';
      wx.showToast({ title: msg, icon: 'none' });
    } finally {
      this.setData({ loading: false });
    }
  },

  // #181：标签分支与搜索/筛选分支共用 page / hasMore，触底判据只剩一条
  onReachBottom() {
    if (this.data.loading || !this.data.hasMore) return;
    const nextPage = this.data.page + 1;
    if (this.data.activeTag) {
      this.loadByTag(this.data.activeTag as TagType, nextPage, false);
    } else {
      this.loadList(nextPage, false);
    }
  },

  onItemTap(e: WechatMiniprogram.TouchEvent) {
    const { id, clientUserId } = e.currentTarget.dataset;
    const params = id ? `id=${id}` : `clientUserId=${clientUserId}`;
    wx.navigateTo({ url: `/packageCustomer/customer-detail/customer-detail?${params}` });
  },

  // ===== 客户分配（仅店长，长按触发） =====
  async onLongPressAssign(e: WechatMiniprogram.TouchEvent) {
    if (!isManager()) return;
    const { clientUserId, name } = e.currentTarget.dataset;
    if (!clientUserId) return;

    // 懒加载员工列表
    if (this.data.staffActions.length === 0) {
      try {
        const response = await callStaffApi<StaffListResponse>('staff.list');
        const staffList = response?.staffList || [];
        this.setData({
          staffActions: staffList
            .filter((staff) => Boolean(staff.staffWfId))
            .map((staff) => ({ name: staff.name, staffWfId: staff.staffWfId })),
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
    if (!isManager()) {
      this.setData({ showAssignSheet: false });
      return;
    }
    const action = e.detail as StaffAction;
    if (!action?.staffWfId) return;
    this.setData({ showAssignSheet: false });
    try {
      const result = await callStaffApi<{ message: string; employeeName: string }>(
        'customer.assign',
        { clientUserId: this.data.assignTarget.clientUserId, employeeId: action.staffWfId },
      );
      wx.showToast({ title: `已分配给${result.employeeName}`, icon: 'success' });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : '分配失败';
      wx.showToast({ title: msg, icon: 'none' });
    }
  },
});
