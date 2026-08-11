// packageMgmt/mgmt-traffic-stats — 管理层"客量数据"子页
// scope 由 hub（mgmt-dashboard）通过路由参数透传，本页不再出 scope-picker
import { isManagementMode } from '../../utils/role'
import { callStaffApi } from '../../utils/cloud'
import { formatAmount, formatCount, formatPercent } from '../../utils/number'

type Period = 'month' | 'lastMonth' | 'year'
type ScopeType = 'all' | 'market' | 'store'

interface TrafficRow {
  type: string
  label: string
  count: number
  users: number
  sessions: number
}

interface TrafficData {
  period: Period
  scope: { type: ScopeType; id: string | null; name: string }
  startDate: string
  endDate: string
  registration: { regTotal: number; regOnly: number; regTrial: number; regMember: number }
  traffic: TrafficRow[]
  status: {
    retainedStable: number
    retainedActive: number
    dormantWarn: number
    dormantFrozen: number
    dormantDeep: number
    activeOnce: number
    activeTwice: number
    reactivatedFromWarn: number
    reactivatedFromFrozen: number
    reactivatedFromDeep: number
  }
  memberOps: {
    buckets: Array<{ tier: string; count: number; spend: number }>
    avgTicket: number
  }
  newMembers: { count: number; spend: number; trialFootfall: number }
}

interface DisplayTrafficRow {
  type: string
  label: string
  count: string
  users: string
  sessions: string
}

interface DisplayBucket {
  tier: string
  tierLabel: string
  count: string
  spend: string
}

interface DisplayData {
  registration: { regTotal: string; regOnly: string; regTrial: string; regMember: string }
  traffic: DisplayTrafficRow[]
  status: {
    retainedStable: string
    retainedActive: string
    dormantWarn: string
    dormantFrozen: string
    dormantDeep: string
    activeOnce: string
    activeTwice: string
    reactivatedFromWarn: string
    reactivatedFromFrozen: string
    reactivatedFromDeep: string
  }
  memberOps: {
    buckets: DisplayBucket[]
    avgTicket: string
  }
  newMembers: {
    count: string
    spend: string
    avgTicket: string
    convRate: string
  }
}

const PERIODS: { key: Period; label: string }[] = [
  { key: 'month',     label: '本月' },
  { key: 'lastMonth', label: '上月' },
  { key: 'year',      label: '本年' },
]

const TIER_LABELS: Record<string, string> = {
  '<1990':   '当期消费<1990',
  '1990-1W': '当期消费≥1990',
  '1-3W':    '当期消费≥1万',
  '3-6W':    '当期消费≥3万',
  '6-10W':   '当期消费≥6万',
  '10W+':    '当期消费10万+',
}

Page({
  data: {
    period: 'month' as Period,
    periods: PERIODS,
    periodsForPicker: PERIODS.map((p) => ({ label: p.label, value: p.key })),
    scopeType: 'all' as ScopeType,
    scopeId: null as string | null,
    scopeName: '',
    loading: false,
    state: 'loading' as 'loading' | 'empty' | 'error' | 'content',
    summary: null as TrafficData | null,
    display: null as DisplayData | null,
  },

  onLoad(query: { scopeType?: string; scopeId?: string; scopeName?: string }) {
    if (!isManagementMode()) {
      wx.reLaunch({ url: '/pages/workbench/workbench' })
      return
    }
    const scopeType = (query?.scopeType as ScopeType) || 'all'
    const scopeId = query?.scopeId || null
    const scopeName = query?.scopeName ? decodeURIComponent(query.scopeName) : ''
    this.setData({
      scopeType,
      scopeId,
      scopeName: scopeName || (scopeType === 'all' ? '全部市场' : ''),
    })
    this.loadSummary()
  },

  onShow() {
    if (!isManagementMode()) {
      wx.reLaunch({ url: '/pages/workbench/workbench' })
    }
  },

  onPeriodChange(e: WechatMiniprogram.CustomEvent<{ value: Period }>) {
    const period = e.detail?.value
    if (!period || period === this.data.period) return
    this.setData({ period })
    this.loadSummary()
  },

  async loadSummary() {
    this.setData({
      loading: true,
      state: this.data.display ? 'content' : 'loading',
    })
    try {
      const summary = await callStaffApi<TrafficData>('mgmtTraffic.summary', {
        period: this.data.period,
        scopeType: this.data.scopeType,
        scopeId: this.data.scopeId,
      })
      this.setData({
        summary,
        display: this.buildDisplay(summary),
        loading: false,
        state: 'content',
      })
    } catch {
      this.setData({
        loading: false,
        state: this.data.display ? 'content' : 'error',
      })
      wx.showToast({ icon: 'none', title: '加载失败，请重试' })
    }
  },

  onRetry() {
    this.loadSummary()
  },

  onPullDownRefresh() {
    this.loadSummary().finally(() => wx.stopPullDownRefresh())
  },

  buildDisplay(s: TrafficData): DisplayData {
    const trafficRows: DisplayTrafficRow[] = (s.traffic || []).map((r) => ({
      type: r.type,
      label: r.label,
      count: formatCount(r.count),
      users: formatCount(r.users),
      sessions: formatCount(r.sessions),
    }))

    const buckets: DisplayBucket[] = (s.memberOps?.buckets || []).map((b) => ({
      tier: b.tier,
      tierLabel: TIER_LABELS[b.tier] || b.tier,
      count: formatCount(b.count),
      spend: formatAmount(b.spend),
    }))

    const nm = s.newMembers
    const avgTicket = nm.count > 0 ? formatAmount(nm.spend / nm.count) : '--'
    const convRate = nm.trialFootfall > 0 ? formatPercent(nm.count / nm.trialFootfall) : '--'

    return {
      registration: {
        regTotal:  formatCount(s.registration.regTotal),
        regOnly:   formatCount(s.registration.regOnly),
        regTrial:  formatCount(s.registration.regTrial),
        regMember: formatCount(s.registration.regMember),
      },
      traffic: trafficRows,
      status: {
        retainedStable:        formatCount(s.status.retainedStable),
        retainedActive:        formatCount(s.status.retainedActive),
        dormantWarn:           formatCount(s.status.dormantWarn),
        dormantFrozen:         formatCount(s.status.dormantFrozen),
        dormantDeep:           formatCount(s.status.dormantDeep),
        activeOnce:            formatCount(s.status.activeOnce),
        activeTwice:           formatCount(s.status.activeTwice),
        reactivatedFromWarn:   formatCount(s.status.reactivatedFromWarn),
        reactivatedFromFrozen: formatCount(s.status.reactivatedFromFrozen),
        reactivatedFromDeep:   formatCount(s.status.reactivatedFromDeep),
      },
      memberOps: {
        buckets,
        avgTicket: formatAmount(s.memberOps.avgTicket),
      },
      newMembers: {
        count:     formatCount(nm.count),
        spend:     formatAmount(nm.spend),
        avgTicket,
        convRate,
      },
    }
  },
})
