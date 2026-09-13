// packageOrder/staff-performance/staff-performance.ts — 员工绩效
import { callStaffApi } from '../../utils/cloud';
import { isManager } from '../../utils/role';
import { formatDateTimeShort } from '../../utils/formatters';
import { formatAmount } from '../../utils/number';

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
  /** 该员工的营业额分配份额（销售类明细「业绩」展示口径） */
  allocAmount?: number | string;
  /** @deprecated 整行实收，后端仅为兼容老版本保留，新版不再展示 */
  businessAmount?: number | string;
  /** 退款冲销行（amount < 0）——在 .ts 预算好，wxml 内不做判断 */
  isRefund?: boolean;
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
  /** 有序分类清单（固定 4 类 + 运行时额外分类），由后端下发，前端不再硬编码 */
  categories?: string[];
  items: PerformanceItem[];
  total: number;
}

/** 二级分类格子（WXML 不支持方法调用，金额必须在此格式化好） */
interface CategoryCell {
  name: string;
  amount: string;
}

/**
 * 金额展示：复用全局 formatAmount（千分位 + Math.round(v+EPSILON) 预舍入，修 1.005→"1.01"）。
 * 先 `Number(v) || 0` 把 null/undefined/NaN 压成 0 —— formatAmount 对无效值返回 '--'，
 * 而 wxml 模板是 `¥{{...}}`，直接透传会渲染出 `¥--`。
 */
function money(v: number | string | undefined | null): string {
  return formatAmount(Number(v) || 0);
}

/** 每页条数：请求入参与 hasMore 判定共用同一常量，勿各写各的 */
const PAGE_SIZE = 20;

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
    // 当前一级 Tab 口径下的各分类金额；分类清单由后端 categories 下发
    categoryCells: [] as CategoryCell[],
    // 格子口径标题 —— 必须标明是「提成」：admin 数据中心的员工效率表有同名 4 列但口径是
    // 营业额分配额，两者差一个费率量级，不标注会被跨端对比成数据错误
    cellsCaption: '',
    // 后端未下发 categorySummary（旧版云函数）时整块隐藏，而不是渲染 4 个假 ¥0.00
    hasCategoryPanel: false,
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
  /** 请求代次：只有最新一次发起的响应才允许写回 data（见 loadData 并发策略） */
  _seq: 0,

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
    // page 由 loadData(reset=true) 内部归 1，调用方不再各自维护
    this.setData({
      showStaffPicker: false,
      selectedStaffIndex: picked,
      staffName: staff.name,
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

    this.setData({ rangeType: type, startDate: start, endDate: end, displayDate: display });
    this.loadData(true);
  },

  onRangeTap(e: WechatMiniprogram.TouchEvent) {
    this.setRange(e.currentTarget.dataset.type as RangeType);
  },

  // ===== 一级 Tab（合计/销售/服务）切换 =====
  // 只换汇总口径与明细的 type 过滤，二级分类选中态保留
  onMainTabChange(e: WechatMiniprogram.CustomEvent) {
    const index = e.detail.index as number;
    this.setData({ activeMainTab: index });
    this.loadData(true);
  },

  // ===== 二级分类（全部/自销自耗/…）切换 =====
  // chip 与汇总格子共用本 handler：再次点击已选中项则回到「全部」
  onSubCategoryTap(e: WechatMiniprogram.TouchEvent) {
    const name = (e.currentTarget.dataset.name as string) || '';
    const next = name === this.data.activeSubCategory ? '' : name;
    if (next === this.data.activeSubCategory) return; // 已是「全部」时再点「全部」，无需重新请求
    this.setData({ activeSubCategory: next });
    this.loadData(true);
  },

  // ===== 加载数据 =====
  //
  // 并发策略：**不靠 loading 布尔早退**。筛选靶点有 9 个（3 Tab + 5 chip + 4 格），
  // 早退会静默吞掉后一次点击 —— 选中态已 setData、请求却没发，导致「UI 选中 X / 列表是 Y」
  // 永久不一致且不会自愈。改用请求代次：每次发起自增 _seq，响应回来时不是最新代次就整个丢弃。
  async loadData(reset: boolean) {
    const seq = ++this._seq;
    // page 作为局部量推导：失败时不会像「先 setData 自增」那样留下永久跳页
    const page = reset ? 1 : this.data.page + 1;
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
        page,
        pageSize: PAGE_SIZE,
      });

      if (seq !== this._seq) return; // 过期响应：期间用户已切换筛选，丢弃避免覆盖新结果

      // 金额统一走 formatAmount（千分位 + EPSILON 预舍入），禁 toLocaleString
      const formattedItems = (res.items || []).map((it) => ({
        ...it,
        date: formatDateTimeShort(it.date),
        // 退款冲销行的提成/分配额是负数，预算成布尔供 wxml 打标识（wxml 内不做判断）
        isRefund: Number(it.amount) < 0,
        amount: money(it.amount),
        allocAmount: money(it.allocAmount),
        fixedFee: money(it.fixedFee),
        consumeAmount: money(it.consumeAmount),
        servicePrice: money(it.servicePrice),
      }));
      const newItems = reset ? formattedItems : [...this.data.items, ...formattedItems];
      // 优先用新字段 totalServiceCommission，回退到旧字段 totalServiceFee（向后兼容）
      const serviceCommission = res.totalServiceCommission ?? res.totalServiceFee ?? 0;
      const total = res.total || 0;
      this.setData({
        totalSalesAlloc: money(res.totalSalesAlloc),
        totalServiceCommission: money(serviceCommission),
        totalCommission: money(res.totalCommission),
        ...this.buildCategoryPanel(res, activeMainTab),
        items: newItems,
        total,
        page,
        // 用后端回带的 page 判断，不比累计长度 —— 长度一旦被过期响应污染，比较逻辑会崩
        hasMore: page * PAGE_SIZE < total,
      });
    } catch (err: unknown) {
      if (seq !== this._seq) return;
      const msg = err instanceof Error ? err.message : '加载失败';
      wx.showToast({ title: msg, icon: 'none' });
      // 切筛选失败时必须清空列表：否则新筛选条件高亮着，下面挂的却是上一次条件的明细
      if (reset) this.setData({ items: [], total: 0, hasMore: false });
    } finally {
      if (seq === this._seq) this.setData({ loading: false });
    }
  },

  /**
   * 由响应推导二级分类面板（格子 + 口径标题 + 显隐）。
   *
   * 纯函数（`mainTab` 从 loadData 传入而非读 this.data）：响应回来时 this.data 可能已被
   * 下一次点击改掉，读它会渲染出「格子按服务口径、明细却是销售行」的错配。
   *
   * 分类清单与零填充都由后端 `categories` / `categorySummary` 负责，前端不持硬编码副本；
   * 旧版云函数不返回 categorySummary → 整块隐藏，避免 4 个假 ¥0.00 与顶部真实金额并列。
   */
  buildCategoryPanel(res: PerformanceResponse, mainTab: number) {
    const summary = res.categorySummary;
    if (!summary) return { hasCategoryPanel: false, categoryCells: [] as CategoryCell[], cellsCaption: '' };

    const categories = res.categories && res.categories.length
      ? res.categories
      : Object.keys(summary);
    const cells = categories.map((name) => {
      const row = summary[name] || { sales: 0, service: 0 };
      const sales = Number(row.sales) || 0;
      const service = Number(row.service) || 0;
      // 一级 Tab 决定格子口径：销售 / 服务 / 合计（两者相加）
      const value = mainTab === 1 ? sales : mainTab === 2 ? service : sales + service;
      return { name, amount: money(value) };
    });
    const caption = mainTab === 1 ? '销售提成构成' : mainTab === 2 ? '服务提成构成' : '提成构成（销售+服务）';
    return { hasCategoryPanel: true, categoryCells: cells, cellsCaption: caption };
  },

  onReachBottom() {
    // 触底仍用 loading 守卫（避免连续触底重复请求同一页）；筛选切换不走这里
    if (this.data.hasMore && !this.data.loading) {
      this.loadData(false);
    }
  },

  // ===== 辅助 =====
  formatDate(d: Date): string {
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  },
});
