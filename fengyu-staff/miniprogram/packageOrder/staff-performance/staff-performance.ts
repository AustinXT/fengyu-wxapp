// packageOrder/staff-performance/staff-performance.ts — 员工绩效
import { callStaffApi } from '../../utils/cloud';
import { isManager } from '../../utils/role';

const app = getApp<IAppOption>();

type RangeType = 'today' | 'month' | 'lastMonth';

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
    // 分类 Tab（5 个子分类）
    activeCategoryTab: 0,
    categoryOptions: ['合计', '销售', '服务', '他销他耗', '生态合作'],
    // 员工筛选（仅店长）
    staffList: [] as Array<{ staffWfId: string; name: string }>,
    selectedStaffIndex: 0,
    staffColumns: [] as string[],
    showStaffPicker: false,
    // 明细列表
    items: [] as any[],
    total: 0,
    page: 1,
    hasMore: false,
  },

  _loaded: false,

  onLoad() {
    const mgr = isManager();
    this.setData({
      isManager: mgr,
      staffName: app.globalData.staffName || '',
    });
    if (mgr) this.loadStaffList();
    this.setRange('today');
    this._loaded = true;
  },

  onShow() {
    if (this._loaded && this.data.startDate) {
      this.loadData(true);
    }
  },

  async loadStaffList() {
    try {
      const data = await callStaffApi<any>('staff.list');
      const list = (data.staffList || []) as Array<{ staffWfId: string; name: string }>;
      const self = app.globalData.staffName || '';
      // 自己放首位
      const columns = [self + '（我）', ...list.filter(s => s.staffWfId !== app.globalData.staffWfId).map(s => s.name)];
      const allStaff = [
        { staffWfId: app.globalData.staffWfId || '', name: self },
        ...list.filter(s => s.staffWfId !== app.globalData.staffWfId),
      ];
      this.setData({ staffList: allStaff, staffColumns: columns });
    } catch (_) {}
  },

  onShowStaffPicker() {
    this.setData({ showStaffPicker: true });
  },

  onStaffPickerClose() {
    this.setData({ showStaffPicker: false });
  },

  onStaffConfirm(e: WechatMiniprogram.CustomEvent) {
    const picked = e.detail.index as number;
    const staff = this.data.staffList[picked];
    if (!staff) return;
    this.setData({
      showStaffPicker: false,
      selectedStaffIndex: picked,
      staffName: staff.name,
      page: 1,
    });
    this.loadData(true);
  },

  // ===== 时间范围切换 =====
  setRange(type: RangeType) {
    const now = new Date();
    let start: string, end: string, display: string;

    if (type === 'today') {
      start = end = this.formatDate(now);
      display = start;
    } else if (type === 'month') {
      const first = new Date(now.getFullYear(), now.getMonth(), 1);
      start = this.formatDate(first);
      end = this.formatDate(now);
      display = `${now.getFullYear()}年${now.getMonth() + 1}月`;
    } else {
      // lastMonth
      const lastMonth = new Date(now.getFullYear(), now.getMonth() - 1, 1);
      const lastMonthEnd = new Date(now.getFullYear(), now.getMonth(), 0);
      start = this.formatDate(lastMonth);
      end = this.formatDate(lastMonthEnd);
      display = `${lastMonth.getFullYear()}年${lastMonth.getMonth() + 1}月`;
    }

    this.setData({ rangeType: type, startDate: start, endDate: end, displayDate: display, page: 1 });
    this.loadData(true);
  },

  onRangeTap(e: WechatMiniprogram.TouchEvent) {
    this.setRange(e.currentTarget.dataset.type as RangeType);
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
      const { activeCategoryTab, staffList, selectedStaffIndex, isManager: isMgr } = this.data;
      // 分类映射：合计/销售/服务/他销他耗/生态合作
      let salesCategory: string | undefined;
      let filterType: string | undefined;
      if (activeCategoryTab === 1) filterType = 'sale';
      else if (activeCategoryTab === 2) filterType = 'service';
      else if (activeCategoryTab === 3) salesCategory = '他销他耗';
      else if (activeCategoryTab === 4) salesCategory = '生态合作';

      // 店长可查看指定员工
      const employeeId = (isMgr && staffList.length > 0) ? staffList[selectedStaffIndex]?.staffWfId : undefined;

      const res = await callStaffApi<any>('staff.performanceDetail', {
        startDate: this.data.startDate,
        endDate: this.data.endDate,
        salesCategory,
        filterType,
        employeeId,
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
