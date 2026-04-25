// pages/sales-data — 管理层"销售数据"页
// 数据来源：staffApi mgmtDashboard.salesData
import { callStaffApi } from '../../utils/cloud'

type Period = 'month' | 'lastMonth' | 'year'
type ExpandedSection = '' | 'salesCategory' | 'productKind' | 'categoryName'

interface BreakdownItem {
  label: string
  value: string
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
  byProductKind: BreakdownItem[]
  byCategoryName: BreakdownItem[]
}

interface IData {
  period: Period
  loading: boolean

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
  byProductKind: BreakdownItem[]
  byCategoryName: BreakdownItem[]

  expandedSection: ExpandedSection
}

const INITIAL_AMOUNT = '0.00'

Page<IData, WechatMiniprogram.IAnyObject>({
  data: {
    period: 'month',
    loading: false,

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
    byCategoryName: [],

    expandedSection: '',
  },

  onLoad() {
    this.loadData()
  },

  onPeriodChange(e: WechatMiniprogram.BaseEvent) {
    const period = (e.currentTarget.dataset as { period?: Period }).period
    if (!period || period === this.data.period) return
    this.setData({ period }, () => this.loadData())
  },

  onToggleSection(e: WechatMiniprogram.BaseEvent) {
    const section = (e.currentTarget.dataset as { section?: ExpandedSection }).section
    if (!section) return
    const next: ExpandedSection = this.data.expandedSection === section ? '' : section
    this.setData({ expandedSection: next })
  },

  async loadData() {
    this.setData({ loading: true })
    try {
      const d = await callStaffApi<SalesDataResp>('mgmtDashboard.salesData', {
        period: this.data.period,
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
        byCategoryName: d.byCategoryName || [],
      })
    } catch {
      wx.showToast({ icon: 'none', title: '数据加载失败' })
    } finally {
      this.setData({ loading: false })
    }
  },
})
