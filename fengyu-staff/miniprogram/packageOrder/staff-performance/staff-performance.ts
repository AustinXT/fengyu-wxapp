// packageOrder/staff-performance/staff-performance.ts — 员工绩效
import { callStaffApi } from '../../utils/cloud';
import { isManager } from '../../utils/role';
import { formatDateTimeShort, maskPhone } from '../../utils/formatters';
import { formatAmount } from '../../utils/number';

const app = getApp<IAppOption>();

/**
 * 时间范围。`custom` 取代了原先的 `lastMonth`：页面纵向已被一级 Tab + 二级 chip + 4 格
 * 分类金额占满，放不下第四个按钮；且服务单不能改归属日期，「本月」经常少掉月初几天，
 * 用任意区间比固定「上月」更管用。旧 deeplink `?range=lastMonth` 由 onLoad 白名单挡下回落 today。
 */
type RangeType = 'today' | 'month' | 'custom';

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
  /** 展示用脱敏号（前端派生，后端不下发）；检索仍走原始 clientPhone */
  customerPhoneMasked?: string;
  /** wx:key 用的稳定唯一键（前端派生）：列表只追加不插队，全局序号即可 */
  rowKey?: string;
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

/**
 * 自定义区间的跨度上限（天）。
 *
 * 后端 `staff.performanceDetail` 没有 SQL LIMIT —— 它把区间内的销售 + 服务行**全量**取回，
 * 内存里 sort 之后再 `slice()` 分页，也就是**每翻一页都重跑一次全区间扫描 + 全量排序**。
 * 「自定义」之前本页最大跨度就是「本月」(≤31 天)，这条路径够不着；一旦放开，
 * 选个 2020 年至今的区间就能把云函数拖到超时。上限卡在前端，picker 同时给绝对上下界。
 * 371 天 = 一年多一点，够覆盖「去年同月」这类真实诉求。
 */
const RANGE_MAX_DAYS = 371;

/**
 * picker 能滚到的最早日期。取业务数据本身的起点——WorkFine 历史订单迁移进来的最早年份，
 * 再往前滚只会得到空列表。
 *
 * **与 RANGE_MAX_DAYS 是两回事**：这条只防止把滚轮甩到 1900 年，**不限制能查多久以前**。
 * 查 2020 年的某 7 天区间既合理、又不会让后端多扫一行，不该被跨度上限连坐挡掉，
 * 所以这里刻意用固定下界而非「今天往前 N 天」的滚动窗口。
 */
const HISTORY_MIN_DATE = '2020-01-01';

/** 检索防抖（毫秒）。只防过滤计算，关键词回显不延迟 */
const SEARCH_DEBOUNCE_MS = 200;

/** 命中窗口按钮文案：窗口还能变大 / 已到硬顶只能整段滑动 */
const LABEL_GROW_WINDOW = '显示更多';
const LABEL_SLIDE_WINDOW = '下一批';

/**
 * 过滤结果的渲染上限。
 *
 * `items` 走路径式增量 setData 绕开了 1MB 上限，但 `displayItems` 是每次过滤整体重建的——
 * 宽泛关键词（比如只打一个「1」）能命中上千条，一次传过去照样超限，
 * 表现是「新页和过滤结果一起更新失败」，正好砸在「搜索激活时继续翻页」这条验收上。
 * 命中几百条本来也不是有效检索（这功能是用来找**某一个**顾客的），所以先渲染一批 + 给
 * 「显示更多」把窗口推大，而不是一次全铺。
 */
const DISPLAY_PAGE_SIZE = 200;

/**
 * 渲染窗口的硬顶。到这儿就只能靠收窄关键词了——再往上单次 setData 会撞 1MB。
 *
 * 按**服务类**明细估：roleType / fixedFee / consumeAmount / servicePrice / sessionUsed / unit
 * 加长中文商品名与分类名，单条序列化可达 ~1KB（销售类轻些）。500 × 1KB ≈ 500KB，
 * 给同一次 setData 里的 items 新页、三项汇总、分类格子留足一倍余量。
 * 别按销售类的均值去放大这个数——超限是**整次 setData 静默失败**，代价远大于少显示几百条。
 */
const HARD_DISPLAY_CAP = 500;

/**
 * 访问被拒类错误 —— 一旦发生就不得继续展示屏幕上的既有数据（可能是他人薪酬）。
 * `PHONE_REQUIRED` 必须在列：`requireStaffBound` 在手机号失效时抛它（admin 改员工资料
 * 时手机号可被置空，路径实际可达），且它与 `PERMISSION_DENIED` 共享 -403，
 * 只能按 errorType 区分、不能按 code 判。
 */
const ACCESS_DENIED_ERRORS = ['UNAUTHORIZED', 'PERMISSION_DENIED', 'PHONE_REQUIRED'];

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
    // 自定义 picker 的绝对上下界（onLoad 算一次）：未来日期不可能有绩效，
    // 过早的起点会让后端全量扫描（见 RANGE_MAX_DAYS）
    customMinDate: '',
    customMaxDate: '',
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
    // 明细列表（items = 已加载的原始明细，displayItems = 过滤后实际渲染的）
    items: [] as PerformanceItem[],
    total: 0,
    page: 1,
    hasMore: false,
    // 顾客检索：**只过滤已加载的 items，不查服务器、不额外翻页**（2026-09-14 甲方拍板口径）
    keyword: '',
    displayItems: [] as PerformanceItem[],
    /** 渲染窗口大小；关键词一变就复位（见 buildSearchView / onShowMoreMatches） */
    displayLimit: DISPLAY_PAGE_SIZE,
    /** 渲染窗口起点：窗口撑到硬顶后改为整段往后滑，保证任何命中项都有路可达 */
    displayOffset: 0,
    /** 窗口后面还有命中 —— wxml 据此显示「显示更多 / 下一批」 */
    hasMoreMatches: false,
    /** 窗口前面还有命中（只有滑过窗口才会出现） */
    hasPrevMatches: false,
    /** 「第 A-B 条」的区间文案，wxml 不支持算式，在 ts 里拼好 */
    matchWindowLabel: '',
    /** 「显示更多」还是「下一批」——取决于窗口是继续变大还是整段滑动 */
    moreMatchesLabel: '显示更多',
    // wxml 不支持方法调用，过滤结果与提示文案都必须在 ts 里算好
    filterActive: false,
    searchHint: '',
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
  /** 检索防抖定时器（onUnload 必须清，否则回调会打到已销毁的页面上） */
  _searchTimer: null as ReturnType<typeof setTimeout> | null,
  /** 上一次真正参与过滤的关键词：用来判断渲染窗口该不该复位 */
  _filteredKeyword: '',
  /** 跨零点定时器：页面停在前台过午夜时把 picker 上界推到新的今天 */
  _midnightTimer: null as ReturnType<typeof setTimeout> | null,
  /**
   * 最后一次**确认渲染完成**的请求代次（只在 setData 回调里推进）。
   * `_seq` 管的是「谁的响应还算数」，这个管的是「屏幕上现在挂的是谁的数据」——
   * 两者会错开：响应 A 已经上屏，紧接着被动刷新把 `_seq` 推到 B，
   * 这时 A 的回调若拿 `_seq` 判断就会放弃提交 `_lastKey`，
   * 后面 B 一失败，catch 里的 sameSource 就会把屏幕上那批同源数据误判成异源清掉。
   */
  _renderedSeq: 0,
  /**
   * 主体世代：换员工 / 换时段 / 清屏时 +1。
   * 迟到的 setData 回调靠它判断「我这批数据是不是已经被抹掉了」——
   * 光比代次不够：清屏并不推进 `_renderedSeq`，旧回调仍会命中相等而把缓存复活回来。
   */
  _subjectEpoch: 0,

  onLoad(options: Record<string, string>) {
    const mgr = isManager();
    this.setData({
      isManager: mgr,
      staffName: app.globalData.staffName || '',
      ...this.dateBounds(),
    });
    if (mgr) this.loadStaffList();
    const validRanges: RangeType[] = ['today', 'month', 'custom'];
    const range = validRanges.includes(options.range as RangeType) ? options.range as RangeType : 'today';
    // 只设日期不取数：紧随其后的 onShow 会发起首次请求。
    // 去掉 loading 早退后，两处各发一次会让每次进页面的云函数调用翻倍，
    // 且「首次成功 + 第二次失败」时成功结果会被代次判过期丢弃，页面反而落到错误态
    this.setRange(range, false);
    this._loaded = true;
  },

  onShow() {
    // 边界每次重算：页面留在页面栈里过夜后，onLoad 那次算出的上界还停在昨天，
    // 当天反而选不进去
    this.refreshDateBounds();
    // onShow 只覆盖「切走再回来」；页面一直停在前台跨午夜时它不会触发，
    // 而此时 picker 可能正展开着，用户直接点就是选不到今天。挂一个到零点的定时器补上
    this.scheduleMidnightRefresh();
    if (!this._loaded || !this.data.startDate) return;

    if (this.syncRangeToToday()) return; // 已经走了完整的重拉流程

    // 被动刷新是完整 reset：翻了几十页再切个后台回来，进度确实会塌回第一页，
    // 体验上不舒服。但**不能**为了保住进度就复用旧的 offset 游标 ——
    // 后端是 offset 分页且每次重新排序，期间只要有新单/退款作废，游标就指偏了：
    // 下一页会把旧的最后一条重复出来、新记录永远翻不到，页面还会显示「已加载 N/共 N 条」
    // 让员工以为查全了。前端拿不到数据版本号，无法可靠判断是否漂移
    // （只比 total + 首条是启发式，中间插入恰好保持两者不变就会漏判）。
    // 要既保进度又保正确，得等后端换成 keyset 游标分页 —— 已登记为 follow-up。
    // 另外这次请求也承担权限重验：隐藏期间员工可能被撤权/调店/手机号被置空，
    // 不发请求就等于把已无权查看的薪酬继续挂在屏幕上。
    this.loadData(true, true);
  },

  /**
   * 把预置档位的区间对齐到「今天」，变了就走完整重拉。返回是否真的重拉了。
   *
   * 页面在页面栈里过夜（onShow）或一直停在前台跨零点（定时器）后，「今日」会一直查进页面
   * 那一天；跨月时「本月」甚至还在查上个月，而按钮高亮和标题都显示得像是当期。
   * custom 是用户手选的区间，不动。
   */
  syncRangeToToday(): boolean {
    if (this.data.rangeType === 'custom') return false;
    const next = this.presetRange(this.data.rangeType);
    if (next.start === this.data.startDate && next.end === this.data.endDate) return false;
    // 区间变了 = 数据主体变了，走完整的清缓存 + 清明细 + 重拉流程，
    // 不能用 keepStaleOnError 把昨天的数据留在屏幕上
    this.setRange(this.data.rangeType);
    return true;
  },

  /**
   * 自定义 picker 的**绝对**上下界。
   *
   * 上界 = 今天：未来日期永远查不出绩效，只会得到一个与「本期无记录」无法区分的空列表。
   * 下界 = 业务数据起点（固定），纯粹防止把滚轮甩到 1900 年，**不是**跨度限制——
   * 跨度由 `applyCustomRange` 的 `daysBetween <= RANGE_MAX_DAYS` 单独把关。
   * 两者必须分开：否则「只能查最近 371 天」会把「查 2020 年某 7 天」这种完全无害的
   * 区间也一起挡掉，而它并不会让后端多扫一行。
   */
  dateBounds() {
    return { customMinDate: HISTORY_MIN_DATE, customMaxDate: this.formatDate(new Date()) };
  },

  /** 只在真的变了才 setData，避免每次 onShow 都往渲染层白发一次通信 */
  refreshDateBounds() {
    const next = this.dateBounds();
    if (next.customMaxDate !== this.data.customMaxDate || next.customMinDate !== this.data.customMinDate) {
      this.setData(next);
    }
  },

  /** 到次日 0:00:05 把 picker 上界推一天，然后续下一天（不是轮询，一天只醒一次） */
  scheduleMidnightRefresh() {
    this.cancelMidnightRefresh();
    const now = new Date();
    const next = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1, 0, 0, 5);
    this._midnightTimer = setTimeout(() => {
      this._midnightTimer = null;
      if (this._disposed) return;
      this.refreshDateBounds();
      // 过了零点，「今日」「本月」的区间同样过期了 —— 只刷 picker 上界的话，
      // 页面会顶着「今日」的高亮继续展示昨天的提成
      this.syncRangeToToday();
      this.scheduleMidnightRefresh();
    }, next.getTime() - now.getTime());
  },

  cancelMidnightRefresh() {
    if (this._midnightTimer) {
      clearTimeout(this._midnightTimer);
      this._midnightTimer = null;
    }
  },

  // 跳下级页时把在途的防抖**跑完**再走，不能只 cancel：
  // 用户改完关键词 200ms 内就离开的话，回来时输入框显示新词、displayItems 还对应旧词，
  // 而 onShow 的被动刷新一旦失败会保留旧数据 —— 这个错配会一直挂着，
  // 直接让员工对「这个顾客是不是我的」得出错误结论
  onHide() {
    this.flushFilter();
    this.cancelMidnightRefresh();
  },

  // 页面销毁后推进代次，丢弃晚到的响应，避免对已卸载页面 setData
  onUnload() {
    this._seq++;
    this._disposed = true;
    this.cancelFilter();
    this.cancelMidnightRefresh();
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
    this.clearSubjectCache();
    this.setData({
      showStaffPicker: false,
      selectedStaffIndex: picked,
      staffName: staff.name,
      loadFailed: false,
      ...this.blankItems(),
      ...this.blankSummary(),
    });
    this.loadData(true);
  },

  // ===== 时间范围切换 =====
  // fetch=false 供 onLoad 使用：只落日期，取数交给紧随的 onShow，避免首屏双发
  setRange(type: RangeType, fetch = true) {
    const { start, end, display } = this.presetRange(type);

    // 什么时候只切 UI、不重拉（后端每次请求都是全区间扫描，白跑一趟既费云函数又闪一下）：
    //
    // ① 同区间的请求正在路上 —— 首屏或失败重试在途时 `_lastKey` 还是空的，连点几下
    //    「自定义」会并发启动多个一模一样的全区间扫描（`_seq` 只丢弃响应，拦不住已经
    //    进了云函数的查询）。在途那次查的本就是这个区间，等它就行。
    // ② **从别的档位切进** custom，且屏幕上已有同源数据 —— 区间是从上一档沿用来的，
    //    数据本就对得上，展开 picker 换个标题即可。
    //
    // 反过来，**已经是 custom 了还点「自定义」** 必须重拉：那和点「今日」「本月」一样是
    // 用户在手动刷新，而且无结果文案里「点上方时段按钮可重查」指的就是这个动作，
    // 吞掉它会让那句指引变成空话。
    //
    // 用 `_lastKey`（上一次**成功**渲染的查询键）而不是 `items.length > 0` 判断有没有同源
    // 数据：后者会把「本期成功查到 0 条」误判成「还没加载」，白白多跑一次全区间扫描。
    const sameRange = start === this.data.startDate && end === this.data.endDate;
    const switchingIntoCustom = this.data.rangeType !== 'custom';
    if (fetch && type === 'custom' && sameRange
        && (this.data.loading || (switchingIntoCustom && this._lastKey))) {
      this.setData({ rangeType: type, displayDate: display });
      return;
    }

    // 换时间段同样是数据主体变化：先清汇总与明细，避免请求在途时
    // 出现「新时段标题 + 旧时段明细」的拼接（与 onStaffConfirm 的清理范围保持一致）
    this.clearSubjectCache();
    this.setData({ rangeType: type, startDate: start, endDate: end, displayDate: display, loadFailed: false, ...this.blankItems(), ...this.blankSummary() });
    if (fetch) this.loadData(true);
  },

  onRangeTap(e: WechatMiniprogram.TouchEvent) {
    const type = e.currentTarget.dataset.type as RangeType;
    // 页面长时间停在前台跨过午夜时收不到 onShow，picker 上界会落后一天。
    // 用户点「自定义」正是要用 picker 的那一刻，在这里补一次刷新
    if (type === 'custom') this.refreshDateBounds();
    this.setRange(type);
  },

  /**
   * 档位 → 区间。不写 data，但 custom 分支会**读** `data.startDate/endDate`（沿用当前区间）。
   * 抽出来是因为 `onShow` 也要用它判断「今天是不是已经不是进页面那天了」——
   * 页面留在页面栈里过夜/跨月时，「今日」必须跟着变成新的今天。
   */
  presetRange(type: RangeType): { start: string; end: string; display: string } {
    const now = new Date();
    if (type === 'today') {
      const d = this.formatDate(now);
      return { start: d, end: d, display: d };
    }
    if (type === 'month') {
      const first = new Date(now.getFullYear(), now.getMonth(), 1);
      return {
        start: this.formatDate(first),
        end: this.formatDate(now),
        display: `${now.getFullYear()}年${now.getMonth() + 1}月`,
      };
    }
    // custom：沿用切换前那一段作为起点（从「今日」进来就是今天，从「本月」进来就是本月），
    // 再由两个 picker 微调 —— 避免展开时出现「无区间」的空态。
    // onLoad 直接收到 ?range=custom 时 data 里还没有日期，回落本月
    const start = this.data.startDate || this.formatDate(new Date(now.getFullYear(), now.getMonth(), 1));
    const end = this.data.endDate || this.formatDate(now);
    return { start, end, display: `${start} ~ ${end}` };
  },

  // ===== 自定义区间：两个 picker =====
  // 刻意**不**给 picker 加 start/end **交叉**约束（business-list-filter 里有）：本页两个日期恒非空，
  // 交叉约束会让「起晚于止」根本选不出来，下面的校验与其对应的验收项就永远不可达、不可测。
  // 但**绝对**上下界（customMinDate / customMaxDate）必须给，理由见 RANGE_MAX_DAYS。
  // 两个入口都补刷边界：页面停在前台跨午夜且 picker 已展开时，用户不会再点「自定义」按钮，
  // 上界会一直停在昨天。这里刷新虽救不了当次（picker 已按旧上界弹出），但下一次点就是对的
  onCustomStartChange(e: WechatMiniprogram.PickerChange) {
    this.refreshDateBounds();
    this.applyCustomRange(String(e.detail.value), this.data.endDate, 'start');
  },

  onCustomEndChange(e: WechatMiniprogram.PickerChange) {
    this.refreshDateBounds();
    this.applyCustomRange(this.data.startDate, String(e.detail.value), 'end');
  },

  /**
   * 落自定义区间。`anchor` 标明用户刚动的是哪一端——那一端是他的真实意图，必须原样保留。
   *
   * 「起晚于止」只 toast、**不写 data**：picker 是受控组件，value 仍绑旧值，显示会自动回退，
   * 用户不会停在一个看着已生效、实则没查的区间上。
   *
   * 「跨度超限」则**不能**照样拒绝，否则两个 picker 各自即时提交会把用户锁死：
   * 从 `2026-09-01 ~ 2026-09-14` 想去 `2020-01-01 ~ 2020-01-07`，
   *   先挪开始 → 跨度 2448 天被拒；先挪结束 → 起晚于止被拒 —— 两个顺序都走不通，
   * `HISTORY_MIN_DATE` 放开的那几年就成了摆设。所以这里保留用户刚动的那端、
   * 把另一端收敛到上限内，用户接着调第二步即可到位。
   *
   * 日期都是 `YYYY-MM-DD` 定宽格式，字典序即时间序，可直接比较。
   */
  applyCustomRange(start: string, end: string, anchor: 'start' | 'end' = 'start') {
    if (!start || !end) return;
    // 自己守住格式与绝对边界，不把安全性全押在 wxml 的 picker 属性上：
    // 非法串会让 daysBetween 返回 NaN，而 `NaN > RANGE_MAX_DAYS` 是 false ——
    // 跨度校验会被静默绕过，一个坏区间就这么发到后端去了
    if (!this.isValidDate(start) || !this.isValidDate(end)) return;
    start = this.clampDate(start);
    end = this.clampDate(end);
    if (start > end) {
      wx.showToast({ title: '开始日期不能晚于结束日期', icon: 'none' });
      return;
    }
    // 跨度上限：后端 performanceDetail 是「SQL 全量取回 → 内存 sort → slice 分页」，
    // **每翻一页都重跑一次全区间扫描 + 全量排序**。改自定义区间前最大跨度只有「本月」(≤31 天)，
    // 这条路径够不着；放开后选个跨年区间就能把云函数拖垮，所以上限在前端就得卡死。
    if (this.daysBetween(start, end) > RANGE_MAX_DAYS) {
      if (anchor === 'start') {
        const capped = this.shiftDate(start, RANGE_MAX_DAYS);
        end = capped < this.data.customMaxDate ? capped : this.data.customMaxDate;
      } else {
        const capped = this.shiftDate(end, -RANGE_MAX_DAYS);
        start = capped > HISTORY_MIN_DATE ? capped : HISTORY_MIN_DATE;
      }
      // 收敛结果若与屏幕上的区间完全一致，就不要说「已自动调整」——
      // 下面的同值早退会让页面毫无变化，用户会以为点击丢了
      if (start !== this.data.startDate || end !== this.data.endDate) {
        wx.showToast({ title: `起止最多相差 ${RANGE_MAX_DAYS} 天，另一端已自动调整`, icon: 'none' });
      }
    }
    // 选了同一天通常无需重拉；但**加载失败时例外** —— 在 picker 里重选一遍当前日期
    // 是失败态下最自然的重试手势，早退会让屏幕一直停在「加载失败」、点什么都没反应
    if (start === this.data.startDate && end === this.data.endDate && !this.data.loadFailed) return;

    // 与 setRange 同级的主体变更：清汇总 + 清明细，避免「新区间标题 + 旧区间明细」
    this.clearSubjectCache();
    this.setData({
      rangeType: 'custom' as RangeType,
      startDate: start,
      endDate: end,
      displayDate: `${start} ~ ${end}`,
      loadFailed: false,
      ...this.blankItems(),
      ...this.blankSummary(),
    });
    this.loadData(true);
  },

  // ===== 顾客检索（纯前端过滤已加载明细）=====
  /**
   * 关键词立即回显、过滤延后一拍。
   *
   * 自定义区间放开到 371 天后，一个时段累积上千条明细是正常的（员工翻页核对本就是这功能的
   * 设计用法）。若每敲一个字符都全量过滤再把整个结果数组序列化过桥，低端真机上输入会明显掉帧。
   * `keyword` 本身不防抖——输入框是受控的，晚一拍回显就是卡字。
   */
  onKeywordChange(e: WechatMiniprogram.CustomEvent) {
    // 原样回显，**不要** trim 后写回：van-search 是受控组件，打「张 三」时那个空格正好落在
    // 词尾，trim 会当场把它吃掉，用户根本输不进带空格的姓名。
    // 纯空格不触发过滤由 buildSearchView 里的 `if (!kw) return` 负责，姓名匹配时两侧都剥空白
    const keyword = (e.detail as unknown as string) || '';
    this.setData({ keyword });
    this.scheduleFilter();
  },

  onKeywordClear() {
    // 清空是明确意图，立即生效，不等防抖
    this.cancelFilter();
    this._filteredKeyword = '';
    this.setData({ keyword: '', ...this.buildSearchView(this.data.items, '', this.data.total) });
  },

  scheduleFilter() {
    this.cancelFilter();
    this._searchTimer = setTimeout(() => {
      this._searchTimer = null;
      if (this._disposed) return; // 防抖窗口里页面被关掉，别对已销毁页面 setData
      this._filteredKeyword = this.data.keyword;
      this.setData(this.buildSearchView(this.data.items, this.data.keyword, this.data.total));
    }, SEARCH_DEBOUNCE_MS);
  },

  cancelFilter() {
    if (this._searchTimer) {
      clearTimeout(this._searchTimer);
      this._searchTimer = null;
    }
  },

  /** 有在途防抖就立即结算，保证 keyword 与 displayItems 永远同源 */
  flushFilter() {
    if (!this._searchTimer) return;
    this.flushFilterNow();
  },

  /** 立即按第一屏重新过滤（窗口一并复位） */
  flushFilterNow() {
    this.cancelFilter();
    this._filteredKeyword = this.data.keyword;
    this.setData(this.buildSearchView(this.data.items, this.data.keyword, this.data.total));
  },

  /**
   * 把渲染窗口再推一屏。
   *
   * 命中过多时只渲染前 N 条是为了绕开 setData 的 1MB 上限，但窗口**不能永远钉死在前 200 条**——
   * 翻页新取回的命中项就永远露不出来了，和「搜索激活时新条目立即参与过滤」直接冲突。
   */
  onShowMoreMatches() {
    // 关键词刚改、过滤还没跑完就点按钮：沿用旧 offset/limit 会让新搜索从错误的位置开窗，
    // 前面的命中直接被跳过。这种情况先老老实实按第一屏重新过滤
    if (this.data.keyword !== this._filteredKeyword) {
      this.flushFilterNow();
      return;
    }
    const { displayLimit, displayOffset } = this.data;
    if (displayLimit < HARD_DISPLAY_CAP) {
      // 还没撑到硬顶：把窗口拉大，已经看到的内容留在原位
      const nextLimit = Math.min(displayLimit + DISPLAY_PAGE_SIZE, HARD_DISPLAY_CAP);
      this.setData(this.buildSearchView(this.data.items, this.data.keyword, this.data.total, nextLimit, displayOffset));
      return;
    }
    // 已经到硬顶：整段往后滑一屏。窗口若钉死在前 N 条，后面的命中就永远没有可达路径
    this.setData(this.buildSearchView(
      this.data.items, this.data.keyword, this.data.total, displayLimit, displayOffset + displayLimit,
    ));
    wx.pageScrollTo({ scrollTop: 0, duration: 200 });
  },

  /** 窗口往前滑一屏（滑过头了要能回来） */
  onPrevMatches() {
    if (this.data.keyword !== this._filteredKeyword) {
      this.flushFilterNow();
      return;
    }
    const { displayLimit, displayOffset } = this.data;
    if (displayOffset <= 0) return;
    this.setData(this.buildSearchView(
      this.data.items, this.data.keyword, this.data.total, displayLimit, Math.max(displayOffset - displayLimit, 0),
    ));
    wx.pageScrollTo({ scrollTop: 0, duration: 200 });
  },

  /**
   * 搜索态下的「继续加载下一页」。
   *
   * 不能只让用户下滑：过滤后列表往往只剩几行甚至 0 行，页面高度不足一屏，
   * `onReachBottom` **根本不会触发**——「下滑加载更多再试」会成为点不动的空头承诺。
   * 所以只要还有未加载的页，搜索态就常驻这个入口（不限于命中 0 条）。
   */
  onLoadMoreTap() {
    if (this.data.hasMore && !this.data.loading) this.loadData(false);
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
      // 失败保留旧数据的前提是旧数据与本次请求同源，否则保留的就是别人/别的条件的数据。
      // 员工段回落到本人 staffWfId：店长首屏时 staffList 尚未加载完，employeeId 为 undefined，
      // 加载完后变成自己的 id —— 数据其实同源，键却漂移，会造成无谓的清屏
      const keyEmployee = employeeId || app.globalData.staffWfId || '';
      queryKey = [keyEmployee, this.data.startDate, this.data.endDate, filterType || '', salesCategory || ''].join('|');

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
      const formattedItems = (res.items || []).map((it, i) => ({
        ...it,
        date: formatDateTimeShort(it.date),
        // isRefund 由后端按款项 change_type 判定，不在此从金额符号推断
        amount: money(it.amount),
        allocAmount: money(it.allocAmount),
        fixedFee: money(it.fixedFee),
        consumeAmount: money(it.consumeAmount),
        servicePrice: money(it.servicePrice),
        // 按手机号搜出来的结果得能核对，所以卡片上要展示。
        // **必须和检索侧同口径剥非数字**：`138-0013-8000` 直接喂给 maskPhone 会脱敏错位
        // （出来 `138******8000`），而员工搜的是 `13800138000` —— 搜得到却核对不上，
        // 等于把验收 2 废掉一半。原始 clientPhone 原样留在 item 上供检索
        customerPhoneMasked: maskPhone(this.normalizePhone(it.clientPhone)),
        // wx:key 用它：item 上本来没有 `index` 属性，`wx:key="index"` 是无效键（devtools 告警 +
        // diff 退化成按序比对）。列表只追加不插队，全局序号就是稳定唯一键，
        // displayItems 作为子集也继承同一套键
        rowKey: `${reset ? 0 : this.data.items.length}-${i}`,
      }));
      // 优先用新字段 totalServiceCommission，回退到旧字段 totalServiceFee（向后兼容）
      const serviceCommission = res.totalServiceCommission ?? res.totalServiceFee ?? 0;
      const total = res.total || 0;
      const newItems = reset ? formattedItems : [...this.data.items, ...formattedItems];
      // 翻页只传**新增那一页**，不把已累积的几百上千条重新序列化一遍：
      // setData 单次有 1MB 上限，超了整次调用直接失败（表现是「继续加载」点了没反应，
      // 还会和「没加载够」的提示混在一起，员工根本分不清）。
      // 每条明细 ~600B，全量重传在 1500 条上下就触线 —— 而「自定义」把跨度从「本月」
      // 放宽到 371 天后，高频员工一年上万条，翻到底核对恰恰是本功能的设计用法。
      // 本次写回已经带了最新的 buildSearchView 结果，在途防抖再跑一遍纯属重复过桥
      this.cancelFilter();
      const itemsPatch: Record<string, unknown> = {};
      if (reset) {
        itemsPatch.items = formattedItems;
      } else {
        const base = this.data.items.length;
        formattedItems.forEach((it, i) => { itemsPatch[`items[${base + i}]`] = it; });
      }
      // 过桥期间用户还能继续打字，回调里读 this.data.keyword 就把「新词已过滤完」错记成事实
      const keywordAtBuild = this.data.keyword;
      // 发起时的主体世代：回调里据此判断这批数据是否已被清屏抹掉
      const epochAtSend = this._subjectEpoch;
      this.setData({
        loadFailed: false,
        totalSalesAlloc: money(res.totalSalesAlloc),
        totalServiceCommission: money(serviceCommission),
        totalCommission: money(res.totalCommission),
        ...this.buildCategoryPanel(res.categorySummary, res.categories, activeMainTab, activeSubCategory),
        ...itemsPatch,
        // 关键词跨翻页存活：触底取回的新条目立刻参与过滤，不必重新输入一遍。
        // 未搜索时 displayItems 恒为空数组（wxml 直接渲染 items），不会再传一份全量。
        // 关键词变了就不带旧窗口（复位回第一屏）—— 改完词 200ms 内正好有响应回来时，
        // 上面的 cancelFilter 会吞掉防抖，窗口复位就只剩这一条路；
        // reset（换时段/换员工/被动刷新）时 items 整批换掉，旧窗口起点同样没意义了
        ...this.buildSearchView(
          newItems,
          this.data.keyword,
          total,
          !reset && keywordAtBuild === this._filteredKeyword ? this.data.displayLimit : undefined,
          !reset && keywordAtBuild === this._filteredKeyword ? this.data.displayOffset : undefined,
        ),
        total,
        page,
        // 用本次请求的 page 判断，不比累计长度 —— 长度一旦被过期响应污染，比较逻辑会崩
        hasMore: page * PAGE_SIZE < total,
      }, () => {
        // 这三个是「屏幕上那批数据的身份证」，必须等数据真的过桥落到视图层才提交：
        // 提前写的话，setData 万一失败（比如撞 1MB 上限）它们就和实际渲染的内容对不上，
        // 会把 catch 分支里 keepStaleOnError 的 sameSource 判断、以及切一级 Tab 时
        // 用 _summaryCache 本地重算的分类金额一起带偏。
        if (this._disposed) return;
        // 清屏 / 换主体之后迟到的回调：这批数据早不在屏幕上了，不能复活它的缓存
        if (epochAtSend !== this._subjectEpoch) return;
        // 已经有更新的响应写过屏幕了，旧回调不许倒退覆盖
        if (seq < this._renderedSeq) return;
        // 渲染代次只在这里推进 —— setData 之前就推进的话，
        // 一旦这次写入失败（比如撞 1MB），屏幕上其实还是旧数据，
        // 旧回调却已经被判过期、提交不了它自己的 `_lastKey`
        this._renderedSeq = seq;
        this._lastKey = queryKey;
        this._summaryCache = res.categorySummary && res.categories && res.categories.length
          ? { summary: res.categorySummary, categories: res.categories }
          : null;
        // 关键词只在**还是当初那个词**时才回写：过桥期间用户可能已经改了词，
        // 而新词的防抖过滤会先跑完；这时候把标记回滚成旧词，
        // 下一次点「显示更多/上一批」就会误判成「过滤还没完成」，复位窗口并吞掉这次点击
        if (this.data.keyword === keywordAtBuild) this._filteredKeyword = keywordAtBuild;
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
      const accessDenied = !!errorType && ACCESS_DENIED_ERRORS.indexOf(errorType) >= 0;
      const sameSource = queryKey === this._lastKey;
      // 访问被拒必须**独立于 reset/分页模式**清屏：触底分页（reset=false）时权限被撤销，
      // 若受 reset 限制就只弹个 toast，撤权后的绩效数据继续留在屏幕上
      if (accessDenied || (reset && (!keepStaleOnError || !sameSource))) {
        this.clearSubjectCache(); // 含作废渲染世代，挡住迟到回调把旧缓存写回
        this.setData({ loadFailed: true, ...this.blankItems(), ...this.blankSummary() });
      }
    } finally {
      if (seq === this._seq) this.setData({ loading: false });
    }
  },

  /**
   * 主体变更时失效缓存。**必须与 blankSummary() 同时调用** —— 只清 data 不清缓存的话，
   * 请求在途期间点一级 Tab 会用 `_summaryCache` 本地重算，把上一个员工/时段的分类提成
   * 重新显示出来（且挂在新员工姓名下）。
   */
  clearSubjectCache() {
    this._summaryCache = null;
    this._lastKey = '';
    // 推进主体世代：在途的 setData 回调可能在清屏**之后**才跑，
    // 那时光比代次会命中相等，把刚清掉的旧主体缓存原样写回去。
    // -403 之后尤其危险 —— 切一下一级 Tab 就能用 `_summaryCache` 本地重算出
    // 上一个员工的分类薪酬，直接破掉「访问被拒必须彻底清屏」这条。
    this._subjectEpoch++;
  },

  /**
   * 明细区空白态。**每一处清空 items 都必须走它** —— `displayItems` 是 wxml 实际遍历的数组，
   * 只清 items 不清它，屏幕上会继续挂着上一个员工/时段的过滤结果。
   * 同时归零 total / hasMore：否则清空后残留的 hasMore 会让触底去请求一个不存在的第 2 页。
   * 关键词刻意保留 —— 员工的典型用法是「查张三在我这有没有单」，换时段接着查张三是自然的。
   */
  blankItems() {
    return {
      items: [] as PerformanceItem[],
      total: 0,
      hasMore: false,
      ...this.buildSearchView([], this.data.keyword, 0),
    };
  },

  /**
   * 由「已加载明细 + 关键词」推导渲染列表与提示文案（WXML 不支持方法调用，必须预先算好）。
   *
   * 口径：**只过滤已 setData 的 items，不查服务器、不额外翻页**（2026-09-14 甲方拍板）。
   * 正因为如此，提示文案必须带「已加载 N / 共 M 条」—— 员工用这个功能就是为了核对
   * 「某顾客有没有分配给自己」，若把「没加载够」显示成干净的「无结果」，得到的正是
   * 这功能本要防的那个错误结论。
   *
   * 手机号用**原始** clientPhone 匹配而非卡片上的脱敏串（否则输入被遮掉的几位永远搜不到），
   * 且两侧都先剥非数字再比：`sale_orders.client_phone` 是 varchar(30) **没有格式 CHECK**
   * （对比 `client_wechat_users.phone` 有 `chk_cwu_phone_format`），WorkFine 历史数据里
   * `138-0013-8000` / `+8613800138000` 这类写法真实存在。不归一的话，同一个号
   * 搜销售行搜不到、搜服务行搜得到，而页面还会告诉员工「未找到」。
   *
   * `filterActive` 为假时 `displayItems` 刻意留空，由 wxml 的 `filterActive ? displayItems : items`
   * 决定数据源 —— 否则未搜索时同一份明细会被 setData 序列化两遍，列表 payload 白白翻倍。
   */
  buildSearchView(items: PerformanceItem[], keyword: string, total: number, limit?: number, offset?: number) {
    // 关键词变了就把窗口收回第一屏；翻页/「显示更多」时由调用方显式传入当前窗口
    const windowSize = limit ?? DISPLAY_PAGE_SIZE;
    const kw = (keyword || '').trim().toLowerCase();
    if (!kw) {
      return {
        displayItems: [] as PerformanceItem[],
        filterActive: false,
        searchHint: '',
        displayLimit: DISPLAY_PAGE_SIZE,
        displayOffset: 0,
        hasMoreMatches: false,
        hasPrevMatches: false,
        matchWindowLabel: '',
        moreMatchesLabel: LABEL_GROW_WINDOW,
      };
    }

    // 先全角转半角：中文输入法偶发全角数字（１３８），直接剥 \D 会把它们整个吃掉，
    // kwDigits 变空 → 手机号匹配被静默跳过，员工只看到「未找到」
    // 全角转半角后，只有**整串都像号码**才走手机号匹配。
    // 否则「顾客12」的数字部分 `12` 会被拿去匹配手机号，把所有号里含 12 的人全捞出来 ——
    // 员工搜一个名字，结果冒出几十个不相干的顾客，比搜不到还难用
    // 全角数字**和分隔符**都要转：从微信聊天/通讯录粘贴过来的号码常带全角括号或减号
    // （`（138）0013－8000`），漏转的话 looksLikePhone 判否 → 退化成姓名匹配 → 显示「未找到」，
    // 而粘贴正是手机号输入的主要来源
    const kwHalfWidth = kw.replace(
      /[\uFF10-\uFF19\uFF08\uFF09\uFF0B\uFF0D\uFF0E\u3000]/g,
      (c) => (c === '\u3000' ? ' ' : String.fromCharCode(c.charCodeAt(0) - 0xFEE0)),
    );
    // 白名单要含 `.` 与 `/`：上面刚把全角句点 `．` 转成了 ASCII `.`，白名单漏了它的话，
    // `138.0013.8000` 这种写法会被判成非号码、退化去匹配姓名，必然「未找到」
    const looksLikePhone = /^[\d\s\-+()./]+$/.test(kwHalfWidth);
    // 号码有「带 86」和「不带 86」两种写法，**关键词和明细各自都可能是任意一种**，
    // 所以两边都摊成候选串做交叉匹配，否则同一个号会因为存储格式不同而时灵时不灵：
    //   明细 +8613900139000 + 关键词 139001   → 要靠明细侧的国内串
    //   明细 13900139000    + 关键词 +86 139  → 要靠关键词侧去掉 86 的候选
    // 关键词是片段，所以这里按前缀判断而不是完整 13 位的 normalizePhone
    const kwDigits = looksLikePhone ? kwHalfWidth.replace(/\D/g, '') : '';
    // 剥 86 的候选要求剥完至少剩 3 位（完整号段前缀）：
    //   `+86 139` → `139`  ✓ 用户明确指定了号段，该匹配
    //   `8613`    → `13`   ✗ 输到一半的中间态，拿它匹配会把所有号里含 13 的人涌进来
    const kwCandidates = kwDigits
      ? (/^861[3-9]/.test(kwDigits) && kwDigits.length >= 5 ? [kwDigits, kwDigits.slice(2)] : [kwDigits])
      : [];
    // 姓名两侧都剥空白：关键词写回时已 trim（避免「框里有内容、列表是全量」的哑态），
    // 但词**中间**的空格留着 —— 顾客姓名里也可能有（「张 三」/ 全角空格），
    // 两边都归一才不会出现「看着一模一样却搜不到」
    const kwName = kw.replace(/\s+/g, '');
    const matched = items.filter((it) => {
      if (kwName && String(it.customerName || '').replace(/\s+/g, '').toLowerCase().indexOf(kwName) >= 0) return true;
      if (!kwCandidates.length) return false;
      const raw = String(it.clientPhone || '').replace(/\D/g, '');
      const norm = this.normalizePhone(it.clientPhone);
      return kwCandidates.some((c) => raw.indexOf(c) >= 0 || norm.indexOf(c) >= 0);
    });
    const loaded = `已加载 ${items.length}/共 ${total} 条`;
    // 关键词进文案前截断：整段粘贴进搜索框时，原样内插会把 van-empty 的 description 撑爆
    const shown = kw.length > 12 ? `${keyword.trim().slice(0, 12)}…` : keyword.trim();
    // 窗口起点越界时收回**最后一个完整窗口的起点**，不是 matched.length-1 ——
    // 后者会退化成「只显示最后 1 条，其余全藏在『上一批』后面」
    const lastWindowStart = matched.length > 0
      ? Math.floor((matched.length - 1) / windowSize) * windowSize
      : 0;
    const start = Math.min(Math.max(offset ?? 0, 0), lastWindowStart);
    const end = Math.min(start + windowSize, matched.length);
    const capped = matched.length > windowSize || start > 0;
    return {
      displayItems: capped ? matched.slice(start, end) : matched,
      filterActive: true,
      displayLimit: windowSize,
      displayOffset: start,
      // 窗口后面还有命中就给「显示更多 / 下一批」——**不因为撑到硬顶就关掉**，
      // 否则超过硬顶的命中项永远露不出来，跟「新条目立即参与过滤」直接冲突
      hasMoreMatches: end < matched.length,
      hasPrevMatches: start > 0,
      // 文案在这里算：wxml 里写 `displayLimit < 500` 会和 HARD_DISPLAY_CAP 形成双源，
      // 改了常量就对不上（本仓 memory 里「字段族跨文件漂移」踩过的同类坑）
      moreMatchesLabel: windowSize < HARD_DISPLAY_CAP ? LABEL_GROW_WINDOW : LABEL_SLIDE_WINDOW,
      matchWindowLabel: capped ? `第 ${start + 1}-${end} 条 / 共 ${matched.length} 条命中` : '',
      // 三种文案各有各的必要性：
      // ① total===0：本期一条记录都没有，跟关键词无关。说「未找到张三」会让员工以为
      //    张三的单被分给了别人；但计数仍要带上，否则又退回无信息空态
      // ② 命中：必须标「顶部汇总为全量」，否则「明细只剩 3 条、汇总还是几千块」会被当成数据错误
      // ③ 没命中：带「已加载 N/共 M」，让员工能分辨「真没有」和「没加载够」
      searchHint: total === 0
        ? `本时段暂无提成记录（${loaded}，搜索「${shown}」仍生效）`
        // 具体显示到第几条交给底部的 matchWindowLabel，这里不重复播报
        : capped
          ? `${loaded}，匹配 ${matched.length} 条（顶部汇总为全量，不随搜索变化）`
          : matched.length
            ? `${loaded}，匹配 ${matched.length} 条（顶部汇总为全量，不随搜索变化）`
            // 「已加载 = 总数」看着像查全了，但后端是 offset 分页且每次重新排序，
          // 翻页期间只要有新单或退款，就可能重复一行、漏掉另一行 —— 而这个功能的结论
          // 恰恰是「这个顾客到底有没有分配给我」，说死了会直接导出相反判断
          : items.length >= total
            ? `${loaded}中未找到「${shown}」（翻页期间若有新单可能未纳入，点上方时段按钮可重查）`
            : `${loaded}中未找到「${shown}」`,
    };
  },

  /**
   * 号码归一：剥掉所有非数字，再去掉国内手机号的 `86` 国际前缀。
   *
   * **检索侧与展示侧必须共用它**，否则同一条记录会「搜得到但核对不上」：
   * `+8613900139000` 只剥非数字会得到 13 位的 `8613900139000`，脱敏出来是 `861******9000`，
   * 员工看不到自己输入的那个 `139` 开头，等于白核对。
   * `sale_orders.client_phone` 是 varchar(30) 且没有格式 CHECK，这类写法在 WorkFine 历史数据里真实存在。
   */
  normalizePhone(v: unknown): string {
    const digits = String(v ?? '').replace(/\D/g, '');
    // 剥 86 前要确认剩下的是合法国内手机号段（1[3-9] 开头的 11 位），
    // 否则 `8612345678901` 这种不明号码会被削成 `12345678901`，反而更难对上
    return /^861[3-9]\d{9}$/.test(digits) ? digits.slice(2) : digits;
  },

  /** 两个 `YYYY-MM-DD` 之间的天数（含头不含尾）。用 UTC 构造避开夏令时/时区偏移 */
  daysBetween(start: string, end: string): number {
    const [sy, sm, sd] = start.split('-').map(Number);
    const [ey, em, ed] = end.split('-').map(Number);
    return Math.round((Date.UTC(ey, em - 1, ed) - Date.UTC(sy, sm - 1, sd)) / 86400000);
  },

  /** 严格 `YYYY-MM-DD` 且是真实存在的日期（挡掉 `2026-02-31` 这种合法格式的假日期） */
  isValidDate(v: string): boolean {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(v)) return false;
    const [y, m, d] = v.split('-').map(Number);
    const t = new Date(Date.UTC(y, m - 1, d));
    return t.getUTCFullYear() === y && t.getUTCMonth() === m - 1 && t.getUTCDate() === d;
  },

  /** 钳到 picker 的绝对上下界内（wxml 属性只约束 UI，这里保证进到请求里的值也合规） */
  clampDate(v: string): string {
    if (v < this.data.customMinDate) return this.data.customMinDate;
    if (v > this.data.customMaxDate) return this.data.customMaxDate;
    return v;
  },

  /** `YYYY-MM-DD` 加/减天数，同样走 UTC（与 daysBetween 对称，避免夏令时差出一天） */
  shiftDate(date: string, days: number): string {
    const [y, m, d] = date.split('-').map(Number);
    const t = new Date(Date.UTC(y, m - 1, d) + days * 86400000);
    const pad = (n: number) => String(n).padStart(2, '0');
    return `${t.getUTCFullYear()}-${pad(t.getUTCMonth() + 1)}-${pad(t.getUTCDate())}`;
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
