// pages/mgmt-dashboard — 管理层 Hub 页
// 4 个 tab（首页/排行榜/顾客/我的）在同一页面内切换，避免 wx.reLaunch 开销
import { canAccessManagement } from '../../utils/role'
import { callStaffApi } from '../../utils/cloud'
import { formatAmount, formatCount } from '../../utils/number'

const app = getApp<IAppOption>()

type MgmtTab = 'dashboard' | 'ranking' | 'customers' | 'profile'

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
  storeCount: number
  memberCount: number
  retainedMemberCount: number
  employeeCount: number
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
    maxDate: 0,
    scope: { ...DEFAULT_SCOPE } as ScopeValue,
    defaultScope: { ...DEFAULT_SCOPE } as ScopeValue,
    summary: null as SummaryData | null,
    loading: false,
    display: null as DisplayData | null,
  },

  onLoad(options: { tab?: string }) {
    const tab = options?.tab as MgmtTab | undefined
    if (tab && ['dashboard', 'ranking', 'customers', 'profile'].includes(tab)) {
      this.setData({ activeTab: tab })
    }
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
    const defaultScope = this.computeDefaultScope()
    this.setData({ selectedDate: today, maxDate, scope: defaultScope, defaultScope })
    this.loadSummary()
  },

  computeDefaultScope(): ScopeValue {
    const { staffLevel, roleBindings } = app.globalData
    if (staffLevel === 'headquarters') {
      return { scopeType: 'all', scopeId: null, scopeName: '全部市场' }
    }
    const marketBinding = (roleBindings || []).find((b: any) => b.scopeType === '市场')
    if (marketBinding) {
      return {
        scopeType: 'market',
        scopeId: marketBinding.scopeId,
        scopeName: (marketBinding as any).scopeName || '我的市场',
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
    this.setData({ selectedDate: date, showCalendar: false })
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
    const emp = s.employeeCount
    const stores = s.storeCount

    // 派生字段：除数为 0 时返回 '--'，避免 NaN/Infinity
    const safeDiv = (
      n: number,
      d: number,
      formatter: (v: number) => string,
    ): string => (d > 0 ? formatter(n / d) : '--')

    const perEmpAmount = (n: number) => safeDiv(n, emp, formatAmount)
    const perEmpCount = (n: number) => safeDiv(n, emp, formatCount)

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
      projectCount: { today: '--', month: '--' },

      storeStatus: {
        memberCount: formatCount(s.memberCount),
        retainedMemberCount: formatCount(s.retainedMemberCount),
        retainRate,
        storeCount: formatCount(stores),
        employeeCount: formatCount(emp),
        avgMembersPerStore: safeDiv(s.memberCount, stores, formatCount),
        avgRetainedPerStore: safeDiv(s.retainedMemberCount, stores, formatCount),
        avgMembersPerEmp: safeDiv(s.memberCount, emp, formatCount),
        // 截图中右下重复位：与上一行同口径，按字面渲染（业务暂未给出真实指标）
        avgMembersPerEmp2: safeDiv(s.memberCount, emp, formatCount),
      },

      perEmployee: {
        revenue:      { day: perEmpAmount(s.storeRevenue.today),    month: perEmpAmount(s.storeRevenue.month) },
        shengmeiRev:  { day: perEmpAmount(s.shengmeiRevenue.today), month: perEmpAmount(s.shengmeiRevenue.month) },
        consume:      { day: perEmpAmount(s.storeConsume.today),    month: perEmpAmount(s.storeConsume.month) },
        shengmeiCons: { day: perEmpAmount(s.shengmeiConsume.today), month: perEmpAmount(s.shengmeiConsume.month) },
        footfall:     { day: perEmpCount(s.footfall.today),         month: perEmpCount(s.footfall.month) },
        headcount:    { day: perEmpCount(s.headcount.today),        month: perEmpCount(s.headcount.month) },
        newMembers:   { day: perEmpCount(s.newMembers.today),       month: perEmpCount(s.newMembers.month) },
        projectCount: { day: '--', month: '--' },
      },
    }
  },

  onEntryTap(e: WechatMiniprogram.BaseEvent) {
    const entry = (e.currentTarget.dataset as { entry?: string }).entry
    const labelMap: Record<string, string> = {
      traffic: '客量数据',
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
