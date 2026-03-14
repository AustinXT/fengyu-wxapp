// packageOrder/staff-performance/staff-performance.ts — 员工绩效
import { callStaffApi } from '../../utils/cloud';
import { isManager } from '../../utils/role';

const app = getApp<IAppOption>();

type RangeType = 'today' | 'week' | 'month' | 'custom';

Page({
  data: {
    loading: false,
    isManager: false,
    staffName: '',
    // 时间范围
    rangeType: 'today' as RangeType,
    startDate: '',
    endDate: '',
    displayDate: '',
    // 汇总数据
    totalSalesAlloc: '0.00',
    totalServiceFee: '0.00',
    totalCommission: '0.00',
    // 分类 Tab
    activeCategoryTab: 0,
    categoryOptions: ['合计', '销售', '服务'],
    // 明细列表
    items: [] as any[],
    total: 0,
    page: 1,
    hasMore: false,
  },

  onLoad() {
    this.setData({
      isManager: isManager(),
      staffName: app.globalData.staffName || '',
    });
    this.setRange('today');
  },

  // ===== 时间范围切换 =====
  setRange(type: RangeType) {
    const now = new Date();
    let start: string, end: string, display: string;

    if (type === 'today') {
      start = end = this.formatDate(now);
      display = start;
    } else if (type === 'week') {
      const day = now.getDay();
      const mondayOffset = day === 0 ? -6 : 1 - day;
      const monday = new Date(now);
      monday.setDate(now.getDate() + mondayOffset);
      start = this.formatDate(monday);
      end = this.formatDate(now);
      display = `${start} ~ ${end}`;
    } else if (type === 'month') {
      const first = new Date(now.getFullYear(), now.getMonth(), 1);
      start = this.formatDate(first);
      end = this.formatDate(now);
      display = `${now.getFullYear()}年${now.getMonth() + 1}月`;
    } else {
      return; // custom handled separately
    }

    this.setData({ rangeType: type, startDate: start, endDate: end, displayDate: display, page: 1 });
    this.loadData(true);
  },

  onRangeTap(e: WechatMiniprogram.TouchEvent) {
    const type = e.currentTarget.dataset.type as RangeType;
    if (type === 'custom') {
      // 简化处理：custom 改为上月
      const now = new Date();
      const lastMonth = new Date(now.getFullYear(), now.getMonth() - 1, 1);
      const lastMonthEnd = new Date(now.getFullYear(), now.getMonth(), 0);
      const start = this.formatDate(lastMonth);
      const end = this.formatDate(lastMonthEnd);
      this.setData({
        rangeType: 'custom',
        startDate: start,
        endDate: end,
        displayDate: `${lastMonth.getFullYear()}年${lastMonth.getMonth() + 1}月`,
        page: 1,
      });
      this.loadData(true);
      return;
    }
    this.setRange(type);
  },

  // ===== 分类 Tab 切换 =====
  onCategoryTabChange(e: WechatMiniprogram.CustomEvent) {
    const index = e.detail.index as number;
    this.setData({ activeCategoryTab: index, page: 1 });
    this.loadData(true);
  },

  // ===== 加载数据 =====
  async loadData(reset: boolean) {
    if (this.data.loading) return;
    this.setData({ loading: true });
    try {
      const { activeCategoryTab } = this.data;
      // 分类映射
      let salesCategory: string | undefined;
      if (activeCategoryTab === 1) salesCategory = '自采自销';
      else if (activeCategoryTab === 2) salesCategory = '他销自耗';

      const res = await callStaffApi<any>('staff.performanceDetail', {
        startDate: this.data.startDate,
        endDate: this.data.endDate,
        salesCategory,
        page: this.data.page,
        pageSize: 20,
      });

      const newItems = reset ? (res.items || []) : [...this.data.items, ...(res.items || [])];
      this.setData({
        totalSalesAlloc: (res.totalSalesAlloc || 0).toFixed(2),
        totalServiceFee: (res.totalServiceFee || 0).toFixed(2),
        totalCommission: (res.totalCommission || 0).toFixed(2),
        items: newItems,
        total: res.total || 0,
        hasMore: newItems.length < (res.total || 0),
      });
    } catch (err: any) {
      wx.showToast({ title: err.message || '加载失败', icon: 'none' });
    } finally {
      this.setData({ loading: false });
    }
  },

  onReachBottom() {
    if (this.data.hasMore && !this.data.loading) {
      this.setData({ page: this.data.page + 1 });
      this.loadData(false);
    }
  },

  // ===== 辅助 =====
  formatDate(d: Date): string {
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  },
});
