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

/** 归属分类固定顺序（= db/schema/enums.ts salesCategoryEnum），恒展示 4 格，无数据补 0 */
const FIXED_CATEGORIES = ['自销自耗', '他销自耗', '他销他耗', '生态合作'];

interface PerformanceItem {
  type: 'sale' | 'service';
  productName: string;
  specName: string;
  amount: number | string;
  ratio?: string;
  /** 该员工的营业额分配份额（销售类明细「业绩」展示口径） */
  allocAmount?: number | string;
  /** @deprecated 整行实收，后端仅为兼容老版本保留，新版不再展示 */
  businessAmount?: number | string;
  // sale 独有
  department?: string;
  // service 独有（服务提成双字段拆分）
  roleType?: string;
  fixedFee?: number | string;        // 固定手工费部分
  consumeAmount?: number | string;   // 消耗提成部分
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

/** 归属分类 → {销售提成, 服务提成}；后端恒返回本期全量，不受筛选入参影响 */
type CategorySummary = Record<string, { sales: number; service: number }>;

interface PerformanceResponse {
  totalSalesAlloc: number;
  /** 服务提成新口径（= service_commissions.commission_amount 汇总） */
  totalServiceCommission?: number;
  /** 向后兼容字段，值同 totalServiceCommission */
  totalServiceFee?: number;
  totalCommission: number;
  categorySummary?: CategorySummary;
  items: PerformanceItem[];
  total: number;
}

/** 二级分类格子（WXML 不支持方法调用，金额必须在此格式化好） */
interface CategoryCell {
  name: string;
  amount: string;
}

/** 金额统一两位小数；空值按 0 处理 */
function money(v: number | string | undefined | null): string {
  return (Number(v) || 0).toFixed(2);
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
    // 一级 Tab：业务类型（合计 / 销售 / 服务）
    activeMainTab: 0,
    mainTabs: ['合计', '销售', '服务'],
    // 二级筛选：归属分类（'' = 全部）；与 categoryCells 联动，点格子等价于点 chip
    activeSubCategory: '',
    subCategories: [...FIXED_CATEGORIES],
    // 当前一级 Tab 口径下的 4 个分类金额（合计 = 销售 + 服务）
    categoryCells: FIXED_CATEGORIES.map((name) => ({ name, amount: '0.00' })) as CategoryCell[],
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

  // ===== 一级 Tab（合计/销售/服务）切换 =====
  // 只换汇总口径与明细的 type 过滤，二级分类选中态保留
  onMainTabChange(e: WechatMiniprogram.CustomEvent) {
    const index = e.detail.index as number;
    this.setData({ activeMainTab: index, page: 1 });
    this.loadData(true);
  },

  // ===== 二级分类（全部/自销自耗/…）切换 =====
  // chip 与汇总格子共用本 handler：再次点击已选中项则回到「全部」
  onSubCategoryTap(e: WechatMiniprogram.TouchEvent) {
    const name = (e.currentTarget.dataset.name as string) || '';
    const next = name === this.data.activeSubCategory ? '' : name;
    this.setData({ activeSubCategory: next, page: 1 });
    this.loadData(true);
  },

  // ===== 加载数据 =====
  async loadData(reset: boolean) {
    if (this.data.loading) return;
    this.setData({ loading: true });
    try {
      const { activeMainTab, activeSubCategory, staffList, selectedStaffIndex, isManager: isMgr } = this.data;
      // 两级筛选：一级 Tab → filterType（业务类型），二级 chip → salesCategory（归属分类）
      // 后端只用它们过滤明细，汇总恒全量，因此切换不会让其余维度归零
      const filterType = activeMainTab === 1 ? 'sale' : activeMainTab === 2 ? 'service' : undefined;
      const salesCategory = activeSubCategory || undefined;

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

      // 金额统一两位小数（小程序 toLocaleString 不可靠，一律 toFixed）
      const formattedItems = (res.items || []).map((it) => ({
        ...it,
        date: formatDateTimeShort(it.date),
        amount: money(it.amount),
        allocAmount: money(it.allocAmount),
        fixedFee: money(it.fixedFee),
        consumeAmount: money(it.consumeAmount),
        servicePrice: money(it.servicePrice),
      }));
      const newItems = reset ? formattedItems : [...this.data.items, ...formattedItems];
      // 优先用新字段 totalServiceCommission，回退到旧字段 totalServiceFee（向后兼容）
      const serviceCommission = res.totalServiceCommission ?? res.totalServiceFee ?? 0;
      const { cells, categories } = this.buildCategoryCells(res.categorySummary || {});
      this.setData({
        totalSalesAlloc: (res.totalSalesAlloc || 0).toFixed(2),
        totalServiceCommission: serviceCommission.toFixed(2),
        totalCommission: (res.totalCommission || 0).toFixed(2),
        categoryCells: cells,
        subCategories: categories,
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

  /**
   * 由 categorySummary 推导二级分类格子。
   * - 固定 4 类恒在（无数据显示 ¥0.00），保证 8 维度随时可达
   * - 后端出现固定表之外的分类（如 sales_category 为 NULL 归入的「未分类」）时动态追加，
   *   否则这部分金额凭空消失，「4 子类之和 = 顶部提成」的勾稽会断裂
   * - 当前选中项即使本期无数据也保留在列表里，避免切换时间范围后选中态失焦
   */
  buildCategoryCells(summary: CategorySummary): { cells: CategoryCell[]; categories: string[] } {
    const extras: string[] = [];
    const seen = (name: string) => FIXED_CATEGORIES.indexOf(name) >= 0 || extras.indexOf(name) >= 0;
    Object.keys(summary).forEach((name) => {
      if (!seen(name)) extras.push(name);
    });
    const current = this.data.activeSubCategory;
    if (current && !seen(current)) extras.push(current);

    const categories = [...FIXED_CATEGORIES, ...extras];
    const mainTab = this.data.activeMainTab;
    const cells = categories.map((name) => {
      const row = summary[name] || { sales: 0, service: 0 };
      const sales = Number(row.sales) || 0;
      const service = Number(row.service) || 0;
      // 一级 Tab 决定格子口径：销售 / 服务 / 合计（两者相加）
      const value = mainTab === 1 ? sales : mainTab === 2 ? service : sales + service;
      return { name, amount: value.toFixed(2) };
    });
    return { cells, categories };
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
