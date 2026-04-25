// packageMgmt/mgmt-product-cycle — 管理层"品项数据"子页
// scope 由 hub（mgmt-dashboard）通过路由参数透传，本页不再出 scope-picker
// 持卡人数为截面快照，不随 period 变化（仅 onLoad 时拉一次）
import { canAccessManagement } from '../../utils/role'
import { callStaffApi } from '../../utils/cloud'
import { formatAmount, formatCount } from '../../utils/number'

type Period = 'month' | 'lastMonth' | 'year'
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
]

Page({
  data: {
    period: 'month' as Period,
    periods: PERIODS,
    scopeType: 'all' as ScopeType,
    scopeId: null as string | null,

    cardLoading: false,
    loading: false,

    cardHoldersData: {
      memberCount: 0,
      rows: [] as CardHolderDisplayRow[],
    },
    cycleData: null as CycleStatsResp | null,
    display: null as CycleDisplay | null,
  },

  onLoad(query: { scopeType?: string; scopeId?: string }) {
    const scopeType = (query?.scopeType as ScopeType) || 'all'
    const scopeId = query?.scopeId ? query.scopeId : null
    this.setData({ scopeType, scopeId })
    // 并行触发持卡人数 + 周期数据
    this.loadCardHolders()
    this.loadCycleStats()
  },

  onShow() {
    if (!canAccessManagement()) {
      wx.reLaunch({ url: '/pages/workbench/workbench' })
    }
  },

  onPeriodTap(e: WechatMiniprogram.BaseEvent) {
    const period = (e.currentTarget.dataset as { period?: Period }).period
    if (!period || period === this.data.period) return
    this.setData({ period })
    // 持卡人数不重拉
    this.loadCycleStats()
  },

  async loadCardHolders() {
    this.setData({ cardLoading: true })
    try {
      const resp = await callStaffApi<CardHoldersResp>('mgmtProduct.cardHolders', {
        scopeType: this.data.scopeType,
        scopeId: this.data.scopeId,
      })
      const rows: CardHolderDisplayRow[] = (resp.cardHolders || []).map((r) => ({
        productKind: r.productKind,
        count: formatCount(r.count),
        rate: r.rate == null ? '--' : r.rate.toFixed(2) + '%',
      }))
      this.setData({
        cardHoldersData: {
          memberCount: resp.memberCount || 0,
          rows,
        },
        cardLoading: false,
      })
    } catch {
      this.setData({ cardLoading: false })
      wx.showToast({ icon: 'none', title: '持卡人数加载失败' })
    }
  },

  async loadCycleStats() {
    this.setData({ loading: true })
    try {
      const resp = await callStaffApi<CycleStatsResp>('mgmtProduct.cycleStats', {
        period: this.data.period,
        scopeType: this.data.scopeType,
        scopeId: this.data.scopeId,
      })
      this.setData({
        cycleData: resp,
        display: this.buildDisplay(resp),
        loading: false,
      })
    } catch {
      this.setData({ loading: false })
      // 保留旧 display 防闪屏（不清空）
      wx.showToast({ icon: 'none', title: '加载失败，请重试' })
    }
  },

  buildDisplay(s: CycleStatsResp): CycleDisplay {
    const mapRow = (r: ProductKindRow): ProductKindDisplayRow => ({
      productKind: r.productKind,
      count: formatCount(r.count),
      revenue: formatAmount(r.revenue),
      avgTicket: r.avgTicket == null ? '--' : formatAmount(r.avgTicket),
    })
    return {
      trial:      (s.trial || []).map(mapRow),
      newEntry:   (s.newEntry || []).map(mapRow),
      repurchase: (s.repurchase || []).map(mapRow),
    }
  },
})
