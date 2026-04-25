// pages/sales-data — 管理层"销售数据"页
// 数据来源：staffApi mgmtDashboard.salesData
// scope 由 hub（mgmt-dashboard）通过路由参数透传
import { callStaffApi } from '../../utils/cloud'

type Period = 'month' | 'lastMonth' | 'year'
type ScopeType = 'all' | 'market' | 'store'

interface BreakdownItem {
  label: string
  value: string
  ratio: string
}

interface BreakdownGroup {
  label: string
  value: string
  ratio: string
  children: BreakdownItem[]
}

interface SalesDataResp {
  totalRevenue: string
  xiaomeiRevenue: string
  newMemberRevenue: string
  oldMemberRevenue: string

  totalConsume: string
  xiaomeiProjectConsume: string
  newMemberProjectConsume: string
  oldMemberProjectConsume: string

  xiaomeiProductOut: string
  newMemberProductOut: string
  oldMemberProductOut: string

  bySalesCategory: BreakdownItem[]
  byProductKind: BreakdownGroup[]
}

interface IData {
  period: Period
  scopeType: ScopeType
  scopeId: string | null
  scopeName: string
  loading: boolean
  state: 'loading' | 'error' | 'content'

  totalRevenue: string
  xiaomeiRevenue: string
  newMemberRevenue: string
  oldMemberRevenue: string

  totalConsume: string
  xiaomeiProjectConsume: string
  newMemberProjectConsume: string
  oldMemberProjectConsume: string

  xiaomeiProductOut: string
  newMemberProductOut: string
  oldMemberProductOut: string

  bySalesCategory: BreakdownItem[]
  byProductKind: BreakdownGroup[]
}

const INITIAL_AMOUNT = '0.00'

Page<IData, WechatMiniprogram.IAnyObject>({
  data: {
    period: 'month',
    scopeType: 'all',
    scopeId: null,
    scopeName: '',
    loading: false,
    state: 'loading',

    totalRevenue: INITIAL_AMOUNT,
    xiaomeiRevenue: INITIAL_AMOUNT,
    newMemberRevenue: INITIAL_AMOUNT,
    oldMemberRevenue: INITIAL_AMOUNT,

    totalConsume: INITIAL_AMOUNT,
    xiaomeiProjectConsume: INITIAL_AMOUNT,
    newMemberProjectConsume: INITIAL_AMOUNT,
    oldMemberProjectConsume: INITIAL_AMOUNT,

    xiaomeiProductOut: INITIAL_AMOUNT,
    newMemberProductOut: INITIAL_AMOUNT,
    oldMemberProductOut: INITIAL_AMOUNT,

    bySalesCategory: [],
    byProductKind: [],
  },

  onLoad(query: { scopeType?: string; scopeId?: string; scopeName?: string }) {
    const scopeType = (query?.scopeType as ScopeType) || 'all'
    const scopeId = query?.scopeId || null
    const scopeName = query?.scopeName ? decodeURIComponent(query.scopeName) : ''
    this.setData({ scopeType, scopeId, scopeName })
    this.loadData()
  },

  onPeriodChange(e: WechatMiniprogram.BaseEvent) {
    const period = (e.currentTarget.dataset as { period?: Period }).period
    if (!period || period === this.data.period) return
    this.setData({ period }, () => this.loadData())
  },

  async loadData() {
    this.setData({ loading: true, state: 'loading' })
    try {
      const d = await callStaffApi<SalesDataResp>('mgmtDashboard.salesData', {
        period: this.data.period,
        scope: { type: this.data.scopeType, id: this.data.scopeId || undefined },
      })
      this.setData({
        totalRevenue: d.totalRevenue || INITIAL_AMOUNT,
        xiaomeiRevenue: d.xiaomeiRevenue || INITIAL_AMOUNT,
        newMemberRevenue: d.newMemberRevenue || INITIAL_AMOUNT,
        oldMemberRevenue: d.oldMemberRevenue || INITIAL_AMOUNT,
        totalConsume: d.totalConsume || INITIAL_AMOUNT,
        xiaomeiProjectConsume: d.xiaomeiProjectConsume || INITIAL_AMOUNT,
        newMemberProjectConsume: d.newMemberProjectConsume || INITIAL_AMOUNT,
        oldMemberProjectConsume: d.oldMemberProjectConsume || INITIAL_AMOUNT,
        xiaomeiProductOut: d.xiaomeiProductOut || INITIAL_AMOUNT,
        newMemberProductOut: d.newMemberProductOut || INITIAL_AMOUNT,
        oldMemberProductOut: d.oldMemberProductOut || INITIAL_AMOUNT,
        bySalesCategory: d.bySalesCategory || [],
        byProductKind: d.byProductKind || [],
        state: 'content',
      })
    } catch {
      this.setData({ state: 'error' })
      wx.showToast({ icon: 'none', title: '数据加载失败' })
    } finally {
      this.setData({ loading: false })
    }
  },

  onRetry() {
    this.loadData()
  },

  onPullDownRefresh() {
    this.loadData().finally(() => wx.stopPullDownRefresh())
  },
})
