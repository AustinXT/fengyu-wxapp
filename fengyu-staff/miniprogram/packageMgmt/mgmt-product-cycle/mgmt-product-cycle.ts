// packageMgmt/mgmt-product-cycle — 管理层"品项数据"子页
// scope 由 hub（mgmt-dashboard）通过路由参数透传，本页不再出 scope-picker
// 持卡人数为截面快照，不随 period 变化（仅 onLoad 时拉一次）
import { isManagementMode } from '../../utils/role'
import { callStaffApi } from '../../utils/cloud'
import { formatAmount, formatCount, formatPercent } from '../../utils/number'

type Period = 'month' | 'lastMonth' | 'year' | 'custom'
type ScopeType = 'all' | 'market' | 'store'

interface CardHolderRow {
  productKind: string
  count: number
  rate: number | null // 0-100 数值；null → '--'
}

interface CardHoldersResp {
  memberCount: number
  cardHolders: CardHolderRow[]
}

interface ProductKindRow {
  productKind: string
  count: number
  revenue: number
  avgTicket: number | null // null → '--'
  entryCount?: number
  repurchaseRate?: number | null // 0-1；null → '--'
}

interface CycleStatsResp {
  period: Period
  scope: { type: ScopeType; id: string | null }
  startDate: string
  endDate: string
  trial: ProductKindRow[]
  newEntry: ProductKindRow[]
  repurchase: ProductKindRow[]
}

interface CardHolderDisplayRow {
  productKind: string
  count: string
  rate: string
}

interface ProductKindDisplayRow {
  productKind: string
  count: string
  entryCount: string
  repurchaseRate: string
  revenue: string
  avgTicket: string
}

interface CycleDisplay {
  trial: ProductKindDisplayRow[]
  newEntry: ProductKindDisplayRow[]
  repurchase: ProductKindDisplayRow[]
}

const PERIODS: { key: Period; label: string }[] = [
  { key: 'month',     label: '本月' },
  { key: 'lastMonth', label: '上月' },
  { key: 'year',      label: '本年' },
  { key: 'custom',    label: '自定义' },
]

function pad2(value: number): string {
  return String(value).padStart(2, '0')
}

function formatDate(date: Date): string {
  return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}`
}

function getDefaultRange(): { startDate: string; endDate: string } {
  const now = new Date()
  return {
    startDate: `${now.getFullYear()}-01-01`,
    endDate: formatDate(now),
  }
}

const DEFAULT_RANGE = getDefaultRange()

Page({
  data: {
    period: 'month' as Period,
    periods: PERIODS,
    periodsForPicker: PERIODS.map((p) => ({ label: p.label, value: p.key })),
    startDate: DEFAULT_RANGE.startDate,
    endDate: DEFAULT_RANGE.endDate,
    scopeType: 'all' as ScopeType,
    scopeId: null as string | null,
    scopeName: '' as string,

    cardLoading: false,
    cardError: false,
    loading: false,
    cycleError: false,

    cardHoldersData: {
      memberCount: 0,
      rows: [] as CardHolderDisplayRow[],
    },
    cycleData: null as CycleStatsResp | null,
    display: null as CycleDisplay | null,
  },

  onLoad(query: { scopeType?: string; scopeId?: string; scopeName?: string }) {
    if (!isManagementMode()) {
      wx.reLaunch({ url: '/pages/workbench/workbench' })
      return
    }
    const scopeType = (query?.scopeType as ScopeType) || 'all'
    const scopeId = query?.scopeId ? query.scopeId : null
    const scopeName = query?.scopeName ? decodeURIComponent(query.scopeName) : ''
    this.setData({ scopeType, scopeId, scopeName })
    // 并行触发持卡人数 + 周期数据
    this.loadCardHolders()
    this.loadCycleStats()
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
    // 持卡人数不重拉
    this.loadCycleStats()
  },

  onStartDateChange(e: WechatMiniprogram.CustomEvent<{ value: string }>) {
    const startDate = e.detail?.value
    if (!startDate || startDate === this.data.startDate) return
    this.setData({ startDate })
    if (this.data.period === 'custom') this.loadCycleStats()
  },

  onEndDateChange(e: WechatMiniprogram.CustomEvent<{ value: string }>) {
    const endDate = e.detail?.value
    if (!endDate || endDate === this.data.endDate) return
    this.setData({ endDate })
    if (this.data.period === 'custom') this.loadCycleStats()
  },

  async loadCardHolders() {
    this.setData({ cardLoading: true, cardError: false })
    try {
      const resp = await callStaffApi<CardHoldersResp>('mgmtProduct.cardHolders', {
        scopeType: this.data.scopeType,
        scopeId: this.data.scopeId,
      })
      const rows: CardHolderDisplayRow[] = (resp.cardHolders || []).map((r) => ({
        productKind: r.productKind,
        count: formatCount(r.count),
        rate: r.rate == null ? '--' : formatPercent(r.rate / 100),
      }))
      this.setData({
        cardHoldersData: {
          memberCount: resp.memberCount || 0,
          rows,
        },
        cardLoading: false,
      })
    } catch {
      this.setData({ cardLoading: false, cardError: true })
      wx.showToast({ icon: 'none', title: '持卡人数加载失败' })
    }
  },

  async loadCycleStats() {
    this.setData({ loading: true, cycleError: false })
    try {
      const payload: Record<string, unknown> = {
        period: this.data.period,
        scopeType: this.data.scopeType,
        scopeId: this.data.scopeId,
      }
      if (this.data.period === 'custom') {
        payload.startDate = this.data.startDate
        payload.endDate = this.data.endDate
      }
      const resp = await callStaffApi<CycleStatsResp>('mgmtProduct.cycleStats', payload)
      this.setData({
        cycleData: resp,
        display: this.buildDisplay(resp),
        loading: false,
      })
    } catch {
      this.setData({ loading: false, cycleError: true })
      // 保留旧 display 防闪屏（不清空）
      wx.showToast({ icon: 'none', title: '加载失败，请重试' })
    }
  },

  onCardRetry() {
    this.loadCardHolders()
  },

  onCycleRetry() {
    this.loadCycleStats()
  },

  onPullDownRefresh() {
    Promise.all([this.loadCardHolders(), this.loadCycleStats()])
      .finally(() => wx.stopPullDownRefresh())
  },

  buildDisplay(s: CycleStatsResp): CycleDisplay {
    const mapRow = (r: ProductKindRow): ProductKindDisplayRow => ({
      productKind: r.productKind,
      count: formatCount(r.count),
      entryCount: '',
      repurchaseRate: '',
      revenue: formatAmount(r.revenue),
      avgTicket: r.avgTicket == null ? '--' : formatAmount(r.avgTicket),
    })
    const mapRepurchaseRow = (r: ProductKindRow): ProductKindDisplayRow => ({
      ...mapRow(r),
      entryCount: r.entryCount == null ? '--' : formatCount(r.entryCount),
      repurchaseRate: r.repurchaseRate == null ? '--' : formatPercent(r.repurchaseRate),
    })
    return {
      trial:      (s.trial || []).map(mapRow),
      newEntry:   (s.newEntry || []).map(mapRow),
      repurchase: (s.repurchase || []).map(mapRepurchaseRow),
    }
  },
})
