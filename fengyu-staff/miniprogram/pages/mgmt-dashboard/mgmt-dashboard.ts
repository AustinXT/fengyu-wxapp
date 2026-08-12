// pages/mgmt-dashboard — 管理层 Hub 页
// 4 个 tab（首页/门店排行榜/员工排行榜/我的）在同一页面内切换，避免 wx.reLaunch 开销
import { canSwitchLoginLevel, isManagementMode } from '../../utils/role'
import { callStaffApi } from '../../utils/cloud'
import { formatAmount, formatCount, formatPercent } from '../../utils/number'

const app = getApp<IAppOption>()

type MgmtTab = 'dashboard' | 'storeRanking' | 'staffRanking' | 'profile'

type RankingPeriod = 'month' | 'lastMonth' | 'year'
type StoreRankingMetric =
  | 'revenue' | 'consume' | 'retainedMember'
  | 'newMember' | 'projectCount' | 'footfall'
type StaffRankingMetric =
  | 'revenue' | 'consume' | 'newMember'
  | 'footfall' | 'projectCount' | 'income'

interface StoreRankingRow {
  rank: number
  storeId: string
  storeName: string
  marketName: string
  value: number
}

interface StoreRankingDisplayRow extends StoreRankingRow {
  valueText: string
}

interface StoreRankingResp {
  period: RankingPeriod
  metric: StoreRankingMetric
  unit: 'amount' | 'count'
  rows: StoreRankingRow[]
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

const STORE_RANKING_METRICS: { key: StoreRankingMetric; label: string; unitLabel: string }[] = [
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
    staffName: '',
    phone: '',
    position: '',
    staffLevelLabel: '',
    staffLevel: '',
    basicInfo: null as null | {
      staffName: string
      staffWfId: string
      phoneFormatted: string
      position: string
      staffLevelLabel: string
    },
    roleBindingRows: [] as Array<{ role: string; scopeText: string }>,
    storeScope: null as null | {
      title: string
      stores: string[]
      expanded: boolean
      needToggle: boolean
    },
    canSwitchView: false,

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
    summaryState: 'content' as 'loading' | 'empty' | 'error' | 'content',

    // 门店排行榜
    storeRanking: {
      period: 'month' as RankingPeriod,
      metric: 'revenue' as StoreRankingMetric,
      loading: false,
      error: false,
      rows: [] as StoreRankingDisplayRow[],
      unit: 'amount' as 'amount' | 'count',
    },
    // 员工排行榜
    staffRanking: {
      period: 'month' as RankingPeriod,
      metric: 'revenue' as StaffRankingMetric,
      loading: false,
      error: false,
      rows: [] as StaffRankingDisplayRow[],
      unit: 'amount' as 'amount' | 'count',
    },
    rankingPeriods: RANKING_PERIODS,
    storeRankingMetrics: STORE_RANKING_METRICS,
    staffRankingMetrics: STAFF_RANKING_METRICS,
    // 给 mgmt-period-picker / mgmt-metric-tabs 用的 { label, value } 形态
    rankingPeriodsForPicker: RANKING_PERIODS.map((p) => ({ label: p.label, value: p.key })),
    storeRankingMetricsForTabs: STORE_RANKING_METRICS.map((m) => ({ label: m.label, value: m.key })),
    staffRankingMetricsForTabs: STAFF_RANKING_METRICS.map((m) => ({ label: m.label, value: m.key })),
    storeRankingMetricLabelMap: {} as Record<StoreRankingMetric, string>,
    staffRankingMetricLabelMap: {} as Record<StaffRankingMetric, string>,
  },

  onLoad(options: { tab?: string }) {
    if (!isManagementMode()) {
      wx.reLaunch({ url: '/pages/workbench/workbench' })
      return
    }
    const tab = options?.tab as MgmtTab | undefined
    if (tab && ['dashboard', 'storeRanking', 'staffRanking', 'profile'].includes(tab)) {
      this.setData({ activeTab: tab })
    }
    const storeLabelMap = STORE_RANKING_METRICS.reduce((acc, m) => {
      acc[m.key] = m.unitLabel
      return acc
    }, {} as Record<StoreRankingMetric, string>)
    const staffLabelMap = STAFF_RANKING_METRICS.reduce((acc, m) => {
      acc[m.key] = m.unitLabel
      return acc
    }, {} as Record<StaffRankingMetric, string>)
    this.setData({
      storeRankingMetricLabelMap: storeLabelMap,
      staffRankingMetricLabelMap: staffLabelMap,
    })
  },

  onShow() {
    if (!isManagementMode()) {
      wx.reLaunch({ url: '/pages/workbench/workbench' })
      return
    }
    const { staffName, phone, position, staffLevel } = app.globalData
    this.setData({
      staffName,
      phone,
      position,
      staffLevel: staffLevel || '',
      staffLevelLabel: staffLevel === 'headquarters' ? '总部'
        : staffLevel === 'market' ? '市场'
          : staffLevel === 'store_manager' ? '店长'
            : staffLevel === 'store_staff' ? '门店' : '',
    })

    this.buildProfileData()

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
    const { roleBindings, scopedStores } = app.globalData
    if ((roleBindings || []).some((binding) => binding.scopeType === '总部')) {
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
    // 店长能力角色绑定优先匹配门店，确保默认 scope 落在可执行店长写操作的门店。
    const managerStoreBinding = (roleBindings || []).find(
      (b: any) => (b.isStoreManager ?? b.role === 'manager') && b.scopeType === '门店',
    )
    if (managerStoreBinding?.scopeId) {
      const matched = (scopedStores || []).find(
        (s: any) => s.storeId === managerStoreBinding.scopeId,
      )
      if (matched) {
        return {
          scopeType: 'store',
          scopeId: matched.storeId,
          scopeName: matched.storeName,
        }
      }
    }

    const firstStore = (scopedStores || [])[0]
    if (firstStore) {
      return {
        scopeType: 'store',
        scopeId: firstStore.storeId,
        scopeName: firstStore.storeName,
      }
    }
    return { scopeType: 'store', scopeId: '', scopeName: '' }
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
    this.setData({
      loading: true,
      summaryState: this.data.display ? 'content' : 'loading',
    })
    try {
      const summary = await callStaffApi<SummaryData>('mgmtDashboard.summary', {
        date: this.data.selectedDate,
        scopeType: this.data.scope.scopeType,
        scopeId: this.data.scope.scopeId,
      })
      this.setData({
        summary,
        display: this.buildDisplay(summary),
        loading: false,
        summaryState: 'content',
      })
    } catch {
      this.setData({
        loading: false,
        summaryState: this.data.display ? 'content' : 'error',
      })
      wx.showToast({ icon: 'none', title: '加载失败，请重试' })
    }
  },

  onSummaryRetry() {
    this.loadSummary()
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
        ? formatPercent(s.retainedMemberCount / s.memberCount)
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
    if (entry === 'products') {
      const { scope } = this.data
      const params = [
        `scopeType=${scope.scopeType}`,
        scope.scopeId ? `scopeId=${encodeURIComponent(scope.scopeId)}` : '',
        `scopeName=${encodeURIComponent(scope.scopeName || '')}`,
      ].filter(Boolean).join('&')
      wx.navigateTo({ url: `/packageMgmt/mgmt-product-cycle/mgmt-product-cycle?${params}` })
      return
    }
    if (entry === 'customers') {
      const { scope } = this.data
      const params = [
        `scopeType=${scope.scopeType}`,
        scope.scopeId ? `scopeId=${encodeURIComponent(scope.scopeId)}` : '',
        `scopeName=${encodeURIComponent(scope.scopeName || '')}`,
      ].filter(Boolean).join('&')
      wx.navigateTo({ url: `/packageMgmt/mgmt-customer-list/mgmt-customer-list?${params}` })
      return
    }
    if (entry === 'sales') {
      const { scope } = this.data
      const params = [
        `scopeType=${scope.scopeType}`,
        scope.scopeId ? `scopeId=${encodeURIComponent(scope.scopeId)}` : '',
        `scopeName=${encodeURIComponent(scope.scopeName || '')}`,
      ].filter(Boolean).join('&')
      wx.navigateTo({ url: `/pages/sales-data/sales-data?${params}` })
      return
    }
    const labelMap: Record<string, string> = {}
    const label = entry && labelMap[entry] ? labelMap[entry] : '该页面'
    wx.showToast({ icon: 'none', title: `${label} 页面开发中` })
  },

  onTabChange(e: WechatMiniprogram.CustomEvent<{ key: MgmtTab }>) {
    const key = e.detail?.key
    if (!key || key === this.data.activeTab) return
    this.setData({ activeTab: key })
    if (key === 'storeRanking' && this.data.storeRanking.rows.length === 0) {
      this.loadStoreRanking()
    }
    if (key === 'staffRanking' && this.data.staffRanking.rows.length === 0) {
      this.loadStaffRanking()
    }
  },

  async loadStoreRanking() {
    const { period, metric } = this.data.storeRanking
    this.setData({ 'storeRanking.loading': true, 'storeRanking.error': false })
    try {
      const resp = await callStaffApi<StoreRankingResp>('mgmtDashboard.storeRanking', {
        period,
        metric,
      })
      const formatter = resp.unit === 'amount' ? formatAmount : formatCount
      const rows: StoreRankingDisplayRow[] = resp.rows.map((r) => ({
        ...r,
        valueText: formatter(r.value),
      }))
      this.setData({
        'storeRanking.rows': rows,
        'storeRanking.unit': resp.unit,
        'storeRanking.loading': false,
      })
    } catch {
      this.setData({ 'storeRanking.loading': false, 'storeRanking.error': true })
      wx.showToast({ icon: 'none', title: '排行榜加载失败' })
    }
  },

  async loadStaffRanking() {
    const { period, metric } = this.data.staffRanking
    this.setData({ 'staffRanking.loading': true, 'staffRanking.error': false })
    try {
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
        'staffRanking.rows': rows,
        'staffRanking.unit': resp.unit,
        'staffRanking.loading': false,
      })
    } catch {
      this.setData({ 'staffRanking.loading': false, 'staffRanking.error': true })
      wx.showToast({ icon: 'none', title: '排行榜加载失败' })
    }
  },

  onStoreRankingPeriodChange(e: WechatMiniprogram.CustomEvent<{ value: RankingPeriod }>) {
    const period = e.detail?.value
    if (!period || period === this.data.storeRanking.period) return
    this.setData({
      'storeRanking.period': period,
      'storeRanking.rows': [],
    })
    this.loadStoreRanking()
  },

  onStoreRankingMetricChange(e: WechatMiniprogram.CustomEvent<{ value: StoreRankingMetric }>) {
    const metric = e.detail?.value
    if (!metric || metric === this.data.storeRanking.metric) return
    this.setData({ 'storeRanking.metric': metric })
    this.loadStoreRanking()
  },

  onStaffRankingPeriodChange(e: WechatMiniprogram.CustomEvent<{ value: RankingPeriod }>) {
    const period = e.detail?.value
    if (!period || period === this.data.staffRanking.period) return
    this.setData({
      'staffRanking.period': period,
      'staffRanking.rows': [],
    })
    this.loadStaffRanking()
  },

  onStaffRankingMetricChange(e: WechatMiniprogram.CustomEvent<{ value: StaffRankingMetric }>) {
    const metric = e.detail?.value
    if (!metric || metric === this.data.staffRanking.metric) return
    this.setData({ 'staffRanking.metric': metric })
    this.loadStaffRanking()
  },

  onStoreRankingRetry() {
    this.loadStoreRanking()
  },

  onStaffRankingRetry() {
    this.loadStaffRanking()
  },

  onPullDownRefresh() {
    const { activeTab } = this.data
    const finish = () => wx.stopPullDownRefresh()
    if (activeTab === 'dashboard') {
      this.loadSummary().finally(finish)
    } else if (activeTab === 'storeRanking') {
      this.loadStoreRanking().finally(finish)
    } else if (activeTab === 'staffRanking') {
      this.loadStaffRanking().finally(finish)
    } else {
      this.buildProfileData()
      finish()
    }
  },

  buildProfileData() {
    const g = app.globalData
    const staffLevelLabel = g.staffLevel === 'headquarters' ? '总部'
      : g.staffLevel === 'market' ? '市场'
        : g.staffLevel === 'store_manager' ? '店长'
          : g.staffLevel === 'store_staff' ? '门店' : '--'

    this.setData({
      basicInfo: {
        staffName: g.staffName || '--',
        staffWfId: g.staffWfId || '--',
        phoneFormatted: this.formatPhone(g.phone),
        position: g.position || '--',
        staffLevelLabel,
      },
      roleBindingRows: this.buildRoleBindingRows(g.roleBindings || []),
      storeScope: this.buildStoreScope(g.staffLevel, g.roleBindings || [], g.scopedStores || []),
      canSwitchView: canSwitchLoginLevel(),
    })
  },

  formatPhone(p: string): string {
    if (!p || p.length !== 11) return p || '--'
    return `${p.slice(0, 3)} ${p.slice(3, 7)} ${p.slice(7)}`
  },

  buildRoleBindingRows(bindings: RoleBinding[]) {
    const order: Record<string, number> = { '总部': 0, '市场': 1, '门店': 2, '部门': 3 }
    return [...bindings]
      .sort((a, b) => (order[a.scopeType] ?? 9) - (order[b.scopeType] ?? 9))
      .map(b => ({
        role: b.role,
        scopeText: `${b.scopeType || '--'} · ${b.scopeName || '--'}`,
      }))
  },

  buildStoreScope(_level: StaffLevel, bindings: RoleBinding[], stores: ScopedStore[]) {
    if (stores.length === 0) return null
    let title = ''
    if (bindings.some((binding) => binding.scopeType === '总部')) {
      title = `总部 / 全部门店（共 ${stores.length} 家）`
    } else if (bindings.some((binding) => binding.scopeType === '市场')) {
      const m = bindings.find((binding) => binding.scopeType === '市场')
      title = `市场 · ${m?.scopeName || '--'}（共 ${stores.length} 家）`
    } else {
      title = `门店授权（共 ${stores.length} 家）`
    }
    return {
      title,
      stores: stores.map(s => s.storeName),
      expanded: false,
      needToggle: stores.length > 5,
    }
  },

  onToggleStoreScope() {
    this.setData({ 'storeScope.expanded': !this.data.storeScope?.expanded })
  },

  onSwitchView() {
    wx.showModal({
      title: '切换视图',
      content: '切换到门店视图后页面将重新加载，确认切换？',
      confirmText: '切换',
      success: (res) => { if (res.confirm) app.switchLoginLevel('store') },
    })
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
