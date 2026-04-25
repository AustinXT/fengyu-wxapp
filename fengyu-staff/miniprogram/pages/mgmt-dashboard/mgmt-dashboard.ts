// pages/mgmt-dashboard — 管理层 Hub 页
// 4 个 tab（首页/排行榜/顾客/我的）在同一页面内切换，避免 wx.reLaunch 开销
import { canAccessManagement } from '../../utils/role'
import { callStaffApi } from '../../utils/cloud'
import { formatAmount, formatCount } from '../../utils/number'

const app = getApp<IAppOption>()

type MgmtTab = 'dashboard' | 'ranking' | 'customers' | 'profile'

type RankingPeriod = 'month' | 'lastMonth' | 'year'
type RankingDimension = 'store' | 'staff'
type RankingMetric =
  | 'revenue' | 'consume' | 'retainedMember'
  | 'newMember' | 'projectCount' | 'footfall'
type StaffRankingMetric =
  | 'revenue' | 'consume' | 'newMember'
  | 'footfall' | 'projectCount' | 'income'
type AnyRankingMetric = RankingMetric | StaffRankingMetric

interface RankingRow {
  rank: number
  storeId: string
  storeName: string
  marketName: string
  value: number
}

interface RankingDisplayRow extends RankingRow {
  valueText: string
}

interface RankingResp {
  period: RankingPeriod
  metric: RankingMetric
  unit: 'amount' | 'count'
  rows: RankingRow[]
}

interface StaffRankingRow {
  rank: number
  employeeId: string
  employeeName: string
  storeId: string | null
  storeName: string
  value: number
}

interface StaffRankingDisplayRow extends StaffRankingRow {
  valueText: string
}

interface StaffRankingResp {
  period: RankingPeriod
  metric: StaffRankingMetric
  unit: 'amount' | 'count'
  rows: StaffRankingRow[]
}

const RANKING_PERIODS: { key: RankingPeriod; label: string }[] = [
  { key: 'month',     label: '本月' },
  { key: 'lastMonth', label: '上月' },
  { key: 'year',      label: '本年' },
]

const RANKING_METRICS: { key: RankingMetric; label: string; unitLabel: string }[] = [
  { key: 'revenue',        label: '业绩排名',     unitLabel: '业绩' },
  { key: 'consume',        label: '实耗排名',     unitLabel: '实耗' },
  { key: 'retainedMember', label: '保有会员排名', unitLabel: '保有会员' },
  { key: 'newMember',      label: '新会员排名',   unitLabel: '新会员' },
  { key: 'projectCount',   label: '项目数排名',   unitLabel: '项目数' },
  { key: 'footfall',       label: '客流排名',     unitLabel: '客流' },
]

const STAFF_RANKING_METRICS: { key: StaffRankingMetric; label: string; unitLabel: string }[] = [
  { key: 'revenue',      label: '业绩榜单',   unitLabel: '业绩' },
  { key: 'consume',      label: '实耗榜单',   unitLabel: '实耗' },
  { key: 'newMember',    label: '新会员排名', unitLabel: '新会员' },
  { key: 'footfall',     label: '客流榜单',   unitLabel: '客流' },
  { key: 'projectCount', label: '项目数榜单', unitLabel: '项目数' },
  { key: 'income',       label: '收入榜单',   unitLabel: '收入' },
]

const RANKING_DIMENSIONS: { key: RankingDimension; label: string }[] = [
  { key: 'store', label: '门店' },
  { key: 'staff', label: '员工' },
]

interface ScopeValue {
  scopeType: 'all' | 'market' | 'store'
  scopeId: string | null
  scopeName: string
}

interface SummaryData {
  storeRevenue: { today: number; month: number; monthlyAvgPerStore: number }
  shengmeiRevenue: { today: number; month: number; monthlyAvgPerStore: number }
  storeConsume: { today: number; month: number; monthlyAvgPerStore: number }
  shengmeiConsume: { today: number; month: number; monthlyAvgPerStore: number }
  footfall: { today: number; month: number }
  headcount: { today: number; month: number }
  newMembers: { today: number; month: number }
  projectCount: { today: number; month: number }
  salesCommissionIncome: { today: number; month: number }
  serviceCommissionIncome: { today: number; month: number }
  // T6（2026-04-25）：双口径 — day 用于日维度派生分母 + 屏幕展示，month 用于月维度派生分母
  storeCount: { day: number; month: number }
  employeeCount: { day: number; month: number }
  memberCount: number
  retainedMemberCount: number
}

interface StoreStatusDisplay {
  memberCount: string
  retainedMemberCount: string
  retainRate: string
  storeCount: string
  employeeCount: string
  avgMembersPerStore: string
  avgRetainedPerStore: string
  avgMembersPerEmp: string
  avgMembersPerEmp2: string
}

interface PerEmployeeRow {
  day: string
  month: string
}

interface PerEmployeeDisplay {
  revenue: PerEmployeeRow
  shengmeiRev: PerEmployeeRow
  consume: PerEmployeeRow
  shengmeiCons: PerEmployeeRow
  footfall: PerEmployeeRow
  headcount: PerEmployeeRow
  newMembers: PerEmployeeRow
  projectCount: PerEmployeeRow
  commissionIncome: PerEmployeeRow
}

interface DisplayData {
  storeRevenue: { today: string; month: string; monthlyAvgPerStore: string }
  shengmeiRevenue: { today: string; month: string; monthlyAvgPerStore: string }
  storeConsume: { today: string; month: string; monthlyAvgPerStore: string }
  shengmeiConsume: { today: string; month: string; monthlyAvgPerStore: string }
  footfall: { today: string; month: string }
  headcount: { today: string; month: string }
  newMembers: { today: string; month: string }
  projectCount: { today: string; month: string }
  storeStatus: StoreStatusDisplay
  perEmployee: PerEmployeeDisplay
}

const DEFAULT_SCOPE: ScopeValue = { scopeType: 'all', scopeId: null, scopeName: '全部市场' }

// 日历历史起点：业务系统 2019 年才上线，2015 年留足缓冲
const CALENDAR_MIN_YEAR = 2015

Page({
  data: {
    activeTab: 'dashboard' as MgmtTab,
    canSwitchStore: false,
    staffName: '',
    phone: '',
    position: '',
    staffLevelLabel: '',
    staffLevel: '',

    // 数据中心
    selectedDate: '',
    showCalendar: false,
    minDate: 0,
    maxDate: 0,
    defaultCalendarDate: 0,
    scope: { ...DEFAULT_SCOPE } as ScopeValue,
    defaultScope: { ...DEFAULT_SCOPE } as ScopeValue,
    summary: null as SummaryData | null,
    loading: false,
    display: null as DisplayData | null,

    // 排行榜
    ranking: {
      dimension: 'store' as RankingDimension,
      period: 'month' as RankingPeriod,
      metric: 'revenue' as AnyRankingMetric,
      loading: false,
      storeRows: [] as RankingDisplayRow[],
      staffRows: [] as StaffRankingDisplayRow[],
      unit: 'amount' as 'amount' | 'count',
    },
    rankingDimensions: RANKING_DIMENSIONS,
    rankingPeriods: RANKING_PERIODS,
    rankingMetrics: RANKING_METRICS,
    staffRankingMetrics: STAFF_RANKING_METRICS,
    rankingMetricLabelMap: {} as Record<RankingMetric, string>,
    staffRankingMetricLabelMap: {} as Record<StaffRankingMetric, string>,
  },

  onLoad(options: { tab?: string }) {
    const tab = options?.tab as MgmtTab | undefined
    if (tab && ['dashboard', 'ranking', 'customers', 'profile'].includes(tab)) {
      this.setData({ activeTab: tab })
    }
    const labelMap = RANKING_METRICS.reduce((acc, m) => {
      acc[m.key] = m.unitLabel
      return acc
    }, {} as Record<RankingMetric, string>)
    const staffLabelMap = STAFF_RANKING_METRICS.reduce((acc, m) => {
      acc[m.key] = m.unitLabel
      return acc
    }, {} as Record<StaffRankingMetric, string>)
    this.setData({
      rankingMetricLabelMap: labelMap,
      staffRankingMetricLabelMap: staffLabelMap,
    })
  },

  onShow() {
    if (!canAccessManagement()) {
      wx.reLaunch({ url: '/pages/workbench/workbench' })
      return
    }
    const { staffName, phone, position, staffLevel, availableLoginLevels } = app.globalData
    this.setData({
      canSwitchStore: (availableLoginLevels || []).includes('store'),
      staffName,
      phone,
      position,
      staffLevel: staffLevel || '',
      staffLevelLabel: staffLevel === 'headquarters' ? '总部' : staffLevel === 'market' ? '市场' : '',
    })

    if (this.data.activeTab === 'dashboard' && !this.data.selectedDate) {
      this.initDashboard()
    }
  },

  initDashboard() {
    const now = new Date()
    const pad = (n: number) => String(n).padStart(2, '0')
    const today = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`
    const maxDate = now.getTime()
    const minDate = new Date(CALENDAR_MIN_YEAR, 0, 1).getTime()
    const defaultScope = this.computeDefaultScope()
    this.setData({
      selectedDate: today,
      minDate,
      maxDate,
      defaultCalendarDate: maxDate,
      scope: defaultScope,
      defaultScope,
    })
    this.loadSummary()
  },

  computeDefaultScope(): ScopeValue {
    const { staffLevel, roleBindings } = app.globalData
    if (staffLevel === 'headquarters') {
      return { scopeType: 'all', scopeId: null, scopeName: '全部市场' }
    }
    const marketBinding = (roleBindings || []).find((b: any) => b.scopeType === '市场')
    if (marketBinding) {
      // scopeName 留空，由 mgmt-scope-picker 加载 scopeOptions 后回填真实市场名
      return {
        scopeType: 'market',
        scopeId: marketBinding.scopeId,
        scopeName: '',
      }
    }
    return { scopeType: 'all', scopeId: null, scopeName: '全部市场' }
  },

  onCalendarOpen() {
    this.setData({ showCalendar: true })
  },

  onCalendarClose() {
    this.setData({ showCalendar: false })
  },

  onCalendarConfirm(e: WechatMiniprogram.CustomEvent<Date>) {
    const d = e.detail
    const pad = (n: number) => String(n).padStart(2, '0')
    const date = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
    this.setData({
      selectedDate: date,
      showCalendar: false,
      defaultCalendarDate: d.getTime(),
    })
    this.loadSummary()
  },

  onScopeChange(e: WechatMiniprogram.CustomEvent<ScopeValue>) {
    this.setData({ scope: e.detail })
    this.loadSummary()
  },

  async loadSummary() {
    if (!this.data.selectedDate) return
    this.setData({ loading: true })
    try {
      const summary = await callStaffApi<SummaryData>('mgmtDashboard.summary', {
        date: this.data.selectedDate,
        scopeType: this.data.scope.scopeType,
        scopeId: this.data.scope.scopeId,
      })
      this.setData({ summary, display: this.buildDisplay(summary), loading: false })
    } catch {
      this.setData({ loading: false })
      wx.showToast({ icon: 'none', title: '加载失败，请重试' })
    }
  },

  buildDisplay(s: SummaryData): DisplayData {
    // T6（2026-04-25）：双口径分母 — day 给当日 / 屏幕展示用，month 给月度派生分母用
    const empDay = s.employeeCount.day
    const empMonth = s.employeeCount.month
    const storesDay = s.storeCount.day

    // 派生字段：除数为 0 时返回 '--'，避免 NaN/Infinity
    const safeDiv = (
      n: number,
      d: number,
      formatter: (v: number) => string,
    ): string => (d > 0 ? formatter(n / d) : '--')

    const perEmpAmount = (n: number, denom: number) => safeDiv(n, denom, formatAmount)
    const perEmpCount = (n: number, denom: number) => safeDiv(n, denom, formatCount)

    const retainRate =
      s.memberCount > 0
        ? ((s.retainedMemberCount / s.memberCount) * 100).toFixed(2) + '%'
        : '--'

    return {
      storeRevenue: {
        today: formatAmount(s.storeRevenue.today),
        month: formatAmount(s.storeRevenue.month),
        monthlyAvgPerStore: formatAmount(s.storeRevenue.monthlyAvgPerStore),
      },
      shengmeiRevenue: {
        today: formatAmount(s.shengmeiRevenue.today),
        month: formatAmount(s.shengmeiRevenue.month),
        monthlyAvgPerStore: formatAmount(s.shengmeiRevenue.monthlyAvgPerStore),
      },
      storeConsume: {
        today: formatAmount(s.storeConsume.today),
        month: formatAmount(s.storeConsume.month),
        monthlyAvgPerStore: formatAmount(s.storeConsume.monthlyAvgPerStore),
      },
      shengmeiConsume: {
        today: formatAmount(s.shengmeiConsume.today),
        month: formatAmount(s.shengmeiConsume.month),
        monthlyAvgPerStore: formatAmount(s.shengmeiConsume.monthlyAvgPerStore),
      },
      footfall: { today: formatCount(s.footfall.today), month: formatCount(s.footfall.month) },
      headcount: { today: formatCount(s.headcount.today), month: formatCount(s.headcount.month) },
      newMembers: { today: formatCount(s.newMembers.today), month: formatCount(s.newMembers.month) },
      projectCount: { today: formatCount(s.projectCount.today), month: formatCount(s.projectCount.month) },

      storeStatus: {
        memberCount: formatCount(s.memberCount),
        retainedMemberCount: formatCount(s.retainedMemberCount),
        retainRate,
        // 屏幕展示卡：按 selectedDate 当日的截面
        storeCount: formatCount(storesDay),
        employeeCount: formatCount(empDay),
        avgMembersPerStore: safeDiv(s.memberCount, storesDay, formatCount),
        avgRetainedPerStore: safeDiv(s.retainedMemberCount, storesDay, formatCount),
        avgMembersPerEmp: safeDiv(s.memberCount, empDay, formatCount),
        // 截图中右下重复位：与上一行同口径，按字面渲染（业务暂未给出真实指标）
        avgMembersPerEmp2: safeDiv(s.memberCount, empDay, formatCount),
      },

      perEmployee: {
        revenue:      { day: perEmpAmount(s.storeRevenue.today,    empDay), month: perEmpAmount(s.storeRevenue.month,    empMonth) },
        shengmeiRev:  { day: perEmpAmount(s.shengmeiRevenue.today, empDay), month: perEmpAmount(s.shengmeiRevenue.month, empMonth) },
        consume:      { day: perEmpAmount(s.storeConsume.today,    empDay), month: perEmpAmount(s.storeConsume.month,    empMonth) },
        shengmeiCons: { day: perEmpAmount(s.shengmeiConsume.today, empDay), month: perEmpAmount(s.shengmeiConsume.month, empMonth) },
        footfall:     { day: perEmpCount(s.footfall.today,     empDay), month: perEmpCount(s.footfall.month,     empMonth) },
        headcount:    { day: perEmpCount(s.headcount.today,    empDay), month: perEmpCount(s.headcount.month,    empMonth) },
        newMembers:   { day: perEmpCount(s.newMembers.today,   empDay), month: perEmpCount(s.newMembers.month,   empMonth) },
        projectCount: { day: perEmpCount(s.projectCount.today, empDay), month: perEmpCount(s.projectCount.month, empMonth) },
        commissionIncome: {
          day:   perEmpAmount(s.salesCommissionIncome.today + s.serviceCommissionIncome.today, empDay),
          month: perEmpAmount(s.salesCommissionIncome.month + s.serviceCommissionIncome.month, empMonth),
        },
      },
    }
  },

  onEntryTap(e: WechatMiniprogram.BaseEvent) {
    const entry = (e.currentTarget.dataset as { entry?: string }).entry
    if (entry === 'traffic') {
      const { scope } = this.data
      const params = [
        `scopeType=${scope.scopeType}`,
        scope.scopeId ? `scopeId=${encodeURIComponent(scope.scopeId)}` : '',
        `scopeName=${encodeURIComponent(scope.scopeName || '')}`,
      ].filter(Boolean).join('&')
      wx.navigateTo({ url: `/packageMgmt/mgmt-traffic-stats/mgmt-traffic-stats?${params}` })
      return
    }
    const labelMap: Record<string, string> = {
      sales: '销售数据',
      products: '品项数据',
      customers: '顾客档案',
    }
    const label = entry && labelMap[entry] ? labelMap[entry] : '该页面'
    wx.showToast({ icon: 'none', title: `${label} 页面开发中` })
  },

  onTabChange(e: WechatMiniprogram.CustomEvent<{ key: MgmtTab }>) {
    const key = e.detail?.key
    if (!key || key === this.data.activeTab) return
    this.setData({ activeTab: key })
    if (key === 'ranking') {
      const { dimension, storeRows, staffRows } = this.data.ranking
      const rowsLen = dimension === 'store' ? storeRows.length : staffRows.length
      if (rowsLen === 0) this.loadRanking()
    }
  },

  async loadRanking() {
    const { dimension, period, metric } = this.data.ranking
    this.setData({ 'ranking.loading': true })
    try {
      if (dimension === 'store') {
        const resp = await callStaffApi<RankingResp>('mgmtDashboard.storeRanking', {
          period,
          metric,
        })
        const formatter = resp.unit === 'amount' ? formatAmount : formatCount
        const rows: RankingDisplayRow[] = resp.rows.map((r) => ({
          ...r,
          valueText: formatter(r.value),
        }))
        this.setData({
          'ranking.storeRows': rows,
          'ranking.unit': resp.unit,
          'ranking.loading': false,
        })
      } else {
        const resp = await callStaffApi<StaffRankingResp>('mgmtDashboard.staffRanking', {
          period,
          metric,
        })
        const formatter = resp.unit === 'amount' ? formatAmount : formatCount
        const rows: StaffRankingDisplayRow[] = resp.rows.map((r) => ({
          ...r,
          valueText: formatter(r.value),
        }))
        this.setData({
          'ranking.staffRows': rows,
          'ranking.unit': resp.unit,
          'ranking.loading': false,
        })
      }
    } catch {
      this.setData({ 'ranking.loading': false })
      wx.showToast({ icon: 'none', title: '排行榜加载失败' })
    }
  },

  onRankingDimensionTap(e: WechatMiniprogram.BaseEvent) {
    const dimension = (e.currentTarget.dataset as { dimension?: RankingDimension }).dimension
    if (!dimension || dimension === this.data.ranking.dimension) return

    // metric 兼容映射：切换 dimension 时若当前 metric 在新维度不存在 → fallback 到 revenue
    const currentMetric = this.data.ranking.metric
    const validInTarget =
      dimension === 'store'
        ? RANKING_METRICS.some((m) => m.key === currentMetric)
        : STAFF_RANKING_METRICS.some((m) => m.key === currentMetric)
    const newMetric: AnyRankingMetric = validInTarget ? currentMetric : 'revenue'

    this.setData({
      'ranking.dimension': dimension,
      'ranking.metric': newMetric,
    })

    // 已有同 metric 的缓存则不重新请求
    const targetRows = dimension === 'store'
      ? this.data.ranking.storeRows
      : this.data.ranking.staffRows
    const hasCache = targetRows.length > 0 && newMetric === currentMetric
    if (!hasCache) this.loadRanking()
  },

  onRankingPeriodTap(e: WechatMiniprogram.BaseEvent) {
    const period = (e.currentTarget.dataset as { period?: RankingPeriod }).period
    if (!period || period === this.data.ranking.period) return
    this.setData({
      'ranking.period': period,
      // 切 period 清空两个维度缓存（数据已变）
      'ranking.storeRows': [],
      'ranking.staffRows': [],
    })
    this.loadRanking()
  },

  onRankingMetricTap(e: WechatMiniprogram.BaseEvent) {
    const metric = (e.currentTarget.dataset as { metric?: AnyRankingMetric }).metric
    if (!metric || metric === this.data.ranking.metric) return
    this.setData({ 'ranking.metric': metric })
    this.loadRanking()
  },

  onSwitchToStore() {
    app.setLoginLevel('store')
    wx.reLaunch({ url: '/pages/workbench/workbench' })
  },

  onLogout() {
    wx.showModal({
      title: '退出登录',
      content: '确认退出当前账号？',
      success: (res) => {
        if (res.confirm) {
          app.resetStaffInfo()
          wx.reLaunch({ url: '/pages/login/login' })
        }
      },
    })
  },
})
