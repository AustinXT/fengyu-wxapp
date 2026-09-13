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
  /** 退款冲销行 —— 后端按款项 `change_type='退款'` 判定，非金额符号推断 */
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
    // 汇总数据（'--' = 尚未加载；首屏与切换主体期间都走这个态，避免与真实零值混淆）
    totalSalesAlloc: '--',
    totalServiceCommission: '--',
    totalCommission: '--',
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
    // 空列表的成因：加载失败 vs 本期确实没有记录 —— 两者文案必须分开，
    // 否则顶部显示 '--'（失败）、列表却说「暂无提成记录」，员工会把失败当成零业绩
    loadFailed: false,
  },

  _loaded: false,
  /** 请求代次：只有最新一次发起的响应才允许写回 data（见 loadData 并发策略） */
  _seq: 0,
  /** 页面已卸载：async 回调写回前的存活检查（_seq 只护 loadData） */
  _disposed: false,
  /** 最后一次成功渲染的查询键（员工+时段+两级筛选）；失败时据此判断旧数据是否还同源 */
  _lastKey: '',
  /** 最后一次成功的全量分类汇总：切一级 Tab 时本地即时换口径，不必等请求返回 */
  _summaryCache: null as { summary: CategorySummary; categories: string[] } | null,

  onLoad(options: Record<string, string>) {
    const mgr = isManager();
    this.setData({
      isManager: mgr,
      staffName: app.globalData.staffName || '',
    });
    if (mgr) this.loadStaffList();
    const validRanges: RangeType[] = ['today', 'month', 'lastMonth'];
    const range = validRanges.includes(options.range as RangeType) ? options.range as RangeType : 'today';
    // 只设日期不取数：紧随其后的 onShow 会发起首次请求。
    // 去掉 loading 早退后，两处各发一次会让每次进页面的云函数调用翻倍，
    // 且「首次成功 + 第二次失败」时成功结果会被代次判过期丢弃，页面反而落到错误态
    this.setRange(range, false);
    this._loaded = true;
  },

  onShow() {
    if (this._loaded && this.data.startDate) {
      // 同主体的被动刷新：失败保留旧数据（见 loadData 的 keepStaleOnError）
      this.loadData(true, true);
    }
  },

  // 页面销毁后推进代次，丢弃晚到的响应，避免对已卸载页面 setData
  onUnload() {
    this._seq++;
    this._disposed = true;
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
      if (this._disposed) return; // 店长进页面后立刻返回时，别对已销毁页面 setData
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
    // 换员工 = 数据主体变了，先清空旧员工的金额快照再拉数（见 blankSummary）
    this.setData({
      showStaffPicker: false,
      selectedStaffIndex: picked,
      staffName: staff.name,
      items: [],
      loadFailed: false,
      ...this.blankSummary(),
    });
    this.loadData(true);
  },

  // ===== 时间范围切换 =====
  // fetch=false 供 onLoad 使用：只落日期，取数交给紧随的 onShow，避免首屏双发
  setRange(type: RangeType, fetch = true) {
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

    // 换时间段同样是数据主体变化：先清汇总与明细，避免请求在途时
    // 出现「新时段标题 + 旧时段明细」的拼接（与 onStaffConfirm 的清理范围保持一致）
    this.setData({ rangeType: type, startDate: start, endDate: end, displayDate: display, items: [], loadFailed: false, ...this.blankSummary() });
    if (fetch) this.loadData(true);
  },

  onRangeTap(e: WechatMiniprogram.TouchEvent) {
    this.setRange(e.currentTarget.dataset.type as RangeType);
  },

  // ===== 一级 Tab（合计/销售/服务）切换 =====
  // 只换汇总口径与明细的 type 过滤，二级分类选中态保留
  onMainTabChange(e: WechatMiniprogram.CustomEvent) {
    const index = e.detail.index as number;
    const cached = this._summaryCache;
    this.setData({
      activeMainTab: index,
      // 分类汇总恒全量、不随筛选变，切一级 Tab 只是换口径 —— 用缓存本地即时重算，
      // 否则慢网下会出现「服务 Tab 已高亮，面板还挂着销售标题和销售金额」
      ...(cached
        ? this.buildCategoryPanel(cached.summary, cached.categories, index, this.data.activeSubCategory)
        : {}),
    });
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
  //
  // keepStaleOnError：同主体的被动刷新（onShow）失败时保留旧数据 —— 旧值是「正确主体的
  // 最后已知值」，抹成 ¥0.00 + 空列表属信息丢失，且页面没有重试入口。只有主体变更
  // （换员工/换时段）与筛选切换失败才需要清，否则新选中态会挂着旧条件的明细。
  async loadData(reset: boolean, keepStaleOnError = false) {
    const seq = ++this._seq;
    // page 作为局部量推导：失败时不会像「先 setData 自增」那样留下永久跳页
    const page = reset ? 1 : this.data.page + 1;
    let queryKey = '';
    this.setData({ loading: true });
    try {
      const { activeMainTab, activeSubCategory, staffList, selectedStaffIndex, isManager: isMgr } = this.data;
      // 两级筛选：一级 Tab → filterType（业务类型），二级 chip → salesCategory（归属分类）
      // 后端只用它们过滤明细，汇总恒全量，因此切换不会让其余维度归零
      const filterType = activeMainTab === 1 ? 'sale' : activeMainTab === 2 ? 'service' : undefined;
      const salesCategory = activeSubCategory || undefined;

      // 店长可查看指定员工
      const employeeId = (isMgr && staffList.length > 0) ? staffList[selectedStaffIndex]?.staffWfId : undefined;

      // 查询键：标识「屏幕上这批数据属于谁的哪个时段哪个筛选」。
      // 失败保留旧数据的前提是旧数据与本次请求同源，否则保留的就是别人/别的条件的数据
      queryKey = [employeeId || '', this.data.startDate, this.data.endDate, filterType || '', salesCategory || ''].join('|');

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
        // isRefund 由后端按款项 change_type 判定，不在此从金额符号推断
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
      this._lastKey = queryKey;
      this._summaryCache = res.categorySummary && res.categories && res.categories.length
        ? { summary: res.categorySummary, categories: res.categories }
        : null;
      this.setData({
        loadFailed: false,
        totalSalesAlloc: money(res.totalSalesAlloc),
        totalServiceCommission: money(serviceCommission),
        totalCommission: money(res.totalCommission),
        ...this.buildCategoryPanel(res.categorySummary, res.categories, activeMainTab, activeSubCategory),
        items: newItems,
        total,
        page,
        // 用本次请求的 page 判断，不比累计长度 —— 长度一旦被过期响应污染，比较逻辑会崩
        hasMore: page * PAGE_SIZE < total,
      });
    } catch (err: unknown) {
      if (seq !== this._seq) return;
      const msg = err instanceof Error ? err.message : '加载失败';
      wx.showToast({ title: msg, icon: 'none' });

      // 保留旧数据只在三个条件同时成立时才安全：
      //   ① 是被动刷新（onShow），不是用户主动切换
      //   ② 本次请求与屏幕上已渲染的那批数据同源（否则 onShow 可能覆盖了一次在途的筛选切换，
      //      保留下来的就是「新 Tab 高亮 + 旧条件明细」）
      //   ③ 不是身份/权限类错误（员工调店、权限撤销后仍把原数据留在屏幕上是越权展示）
      const errorType = (err as { errorType?: string } | null)?.errorType;
      const authError = errorType === 'UNAUTHORIZED' || errorType === 'PERMISSION_DENIED';
      const sameSource = queryKey === this._lastKey;
      if (reset && (!keepStaleOnError || !sameSource || authError)) {
        this._lastKey = '';
        this._summaryCache = null;
        this.setData({ items: [], total: 0, hasMore: false, loadFailed: true, ...this.blankSummary() });
      }
    } finally {
      if (seq === this._seq) this.setData({ loading: false });
    }
  },

  /**
   * 汇总区空白态：换员工 / 换时间段这类「数据主体变了」的场景，必须先把旧主体的金额清掉
   * 再发请求 —— 否则请求在途期间（慢网络下最长一个 RTT）页面会把 A 的提成标在 B 名下，
   * 请求失败时更会永久停在那个错配状态。筛选切换不用清（汇总恒全量、本就不随筛选变）。
   */
  blankSummary() {
    return {
      // 用 '--' 而非 '0.00'：合法零值无法与「尚未加载 / 加载失败」区分，
      // 切到提成非零的员工时那 1~2 秒的 ¥0.00 会被当成真实业绩为零
      totalSalesAlloc: '--',
      totalServiceCommission: '--',
      totalCommission: '--',
      categoryCells: [] as CategoryCell[],
      cellsCaption: '',
      hasCategoryPanel: false,
    };
  },

  /**
   * 由响应推导二级分类面板（格子 + 口径标题 + 显隐）。
   *
   * 纯函数（`mainTab` / `activeSub` 均由 loadData 传入而非读 this.data）：口径必须跟随
   * **发起这次请求时**的选中态，与响应里的明细同源，否则会渲染出「格子按服务口径、
   * 明细却是销售行」的错配。
   *
   * 分类清单与零填充都由后端 `categories` / `categorySummary` 负责，前端不持硬编码副本。
   *
   * ⚠️ 版本闸门必须同时要求 `categories` 存在，不能只判 `categorySummary`：
   * **旧版云函数也返回 categorySummary**，只是不零填充、且会被 salesCategory 入参过滤。
   * 若在缺 `categories` 时回退 `Object.keys(summary)`，旧云函数下会表现为「零金额分类消失、
   * 点某分类后其余格子全部消失」——正是本 issue 要修的老毛病。缺字段一律隐藏整块降级。
   */
  buildCategoryPanel(
    summary: CategorySummary | undefined,
    categories: string[] | undefined,
    mainTab: number,
    activeSub: string,
  ) {
    if (!summary || !categories || !categories.length) {
      return { hasCategoryPanel: false, categoryCells: [] as CategoryCell[], cellsCaption: '' };
    }

    // 当前选中分类若不在本期清单里（如选中「未分类」后切到无 NULL 行的月份），补进来：
    // 否则 chip 与格子都不高亮、「全部」也不高亮，用户面对空列表却找不到过滤器在哪
    const shown = !activeSub || categories.indexOf(activeSub) >= 0
      ? categories
      : categories.concat([activeSub]);

    const cells = shown.map((name) => {
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
