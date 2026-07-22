// pages/sales-data — 管理层"销售数据"页
// 数据来源：staffApi mgmtDashboard.salesData
// scope 由 hub（mgmt-dashboard）通过路由参数透传
import { callStaffApi } from '../../utils/cloud'
import { formatAmount } from '../../utils/number'

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
      // 后端金额为 toFixed(2) 字符串，转回 number 走 formatAmount 补千分位（与 dashboard 口径一致）
      const amt = (v: string | undefined | null): string => formatAmount(Number(v) || 0)
      // 明细：金额 value 补千分位；ratio（百分比）保留后端两位小数串，无需千分位
      const bySalesCategory = (d.bySalesCategory || []).map(it => ({ ...it, value: amt(it.value) }))
      const byProductKind = (d.byProductKind || []).map(g => ({
        ...g,
        value: amt(g.value),
        children: (g.children || []).map(c => ({ ...c, value: amt(c.value) })),
      }))
      this.setData({
        totalRevenue: amt(d.totalRevenue),
        xiaomeiRevenue: amt(d.xiaomeiRevenue),
        newMemberRevenue: amt(d.newMemberRevenue),
        oldMemberRevenue: amt(d.oldMemberRevenue),
        totalConsume: amt(d.totalConsume),
        xiaomeiProjectConsume: amt(d.xiaomeiProjectConsume),
        newMemberProjectConsume: amt(d.newMemberProjectConsume),
        oldMemberProjectConsume: amt(d.oldMemberProjectConsume),
        xiaomeiProductOut: amt(d.xiaomeiProductOut),
        newMemberProductOut: amt(d.newMemberProductOut),
        oldMemberProductOut: amt(d.oldMemberProductOut),
        bySalesCategory,
        byProductKind,
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
