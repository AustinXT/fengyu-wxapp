// packageOrder/staff-performance/staff-performance.ts — 员工绩效
import { callStaffApi } from '../../utils/cloud';
import { isManager } from '../../utils/role';
import { formatDateTimeShort } from '../../utils/formatters';

const app = getApp<IAppOption>();

type RangeType = 'today' | 'month' | 'lastMonth';

interface StaffMember {
  staffWfId: string;
  name: string;
}

interface StaffListResponse {
  staffList: StaffMember[];
}

interface PerformanceItem {
  type: 'sale' | 'service';
  productName: string;
  specName: string;
  amount: number | string;
  ratio?: string;
  businessAmount?: number | string;
  // sale 独有
  department?: string;
  // service 独有（服务提成双字段拆分）
  roleType?: string;
  fixedFee?: number;        // 固定手工费部分
  consumeAmount?: number;   // 消耗提成部分
  commissionRate?: number;  // 提成比例（0.12 = 12%）
  servicePrice?: number | string;  // 单次划卡价（消耗业绩口径，仅展示用）
  sessionUsed?: number;
  unit?: string;
  customerName: string;
  clientPhone?: string;
  orderId?: string;
  date: string;
  salesCategory: string;
}

interface PerformanceResponse {
  totalSalesAlloc: number;
  /** 服务提成新口径（= service_commissions.commission_amount 汇总） */
  totalServiceCommission?: number;
  /** 向后兼容字段，值同 totalServiceCommission */
  totalServiceFee?: number;
  totalCommission: number;
  items: PerformanceItem[];
  total: number;
}

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
    totalServiceCommission: '0.00',
    totalCommission: '0.00',
    // 分类 Tab（5 个子分类）
    activeCategoryTab: 0,
    categoryOptions: ['合计', '销售', '服务', '他销他耗', '生态合作'],
    // 员工筛选（仅店长）
    staffList: [] as StaffMember[],
    selectedStaffIndex: 0,
    staffColumns: [] as string[],
    showStaffPicker: false,
    // 明细列表
    items: [] as PerformanceItem[],
    total: 0,
    page: 1,
    hasMore: false,
  },

  _loaded: false,

  onLoad(options: Record<string, string>) {
    const mgr = isManager();
    this.setData({
      isManager: mgr,
      staffName: app.globalData.staffName || '',
    });
    if (mgr) this.loadStaffList();
    const validRanges: RangeType[] = ['today', 'month', 'lastMonth'];
    const range = validRanges.includes(options.range as RangeType) ? options.range as RangeType : 'today';
    this.setRange(range);
    this._loaded = true;
  },

  onShow() {
    if (this._loaded && this.data.startDate) {
      this.loadData(true);
    }
  },

  async loadStaffList() {
    try {
      const data = await callStaffApi<StaffListResponse>('staff.list');
      const list = data.staffList || [];
      const self = app.globalData.staffName || '';
      // 自己放首位
      const columns = [self + '（我）', ...list.filter(s => s.staffWfId !== app.globalData.staffWfId).map(s => s.name)];
      const allStaff: StaffMember[] = [
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

      const res = await callStaffApi<PerformanceResponse>('staff.performanceDetail', {
        startDate: this.data.startDate,
        endDate: this.data.endDate,
        salesCategory,
        filterType,
        employeeId,
        page: this.data.page,
        pageSize: 20,
      });

      const formattedItems = (res.items || []).map((it) => ({
        ...it,
        date: formatDateTimeShort(it.date),
      }));
      const newItems = reset ? formattedItems : [...this.data.items, ...formattedItems];
      // 优先用新字段 totalServiceCommission，回退到旧字段 totalServiceFee（向后兼容）
      const serviceCommission = res.totalServiceCommission ?? res.totalServiceFee ?? 0;
      this.setData({
        totalSalesAlloc: (res.totalSalesAlloc || 0).toFixed(2),
        totalServiceCommission: serviceCommission.toFixed(2),
        totalCommission: (res.totalCommission || 0).toFixed(2),
        items: newItems,
        total: res.total || 0,
        hasMore: newItems.length < (res.total || 0),
      });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : '加载失败';
      wx.showToast({ title: msg, icon: 'none' });
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
