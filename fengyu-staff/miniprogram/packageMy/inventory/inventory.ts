// packageMy/inventory/inventory.ts — 库存管理首页

type CategoryKey = 'stocks' | 'procurement' | 'sale' | 'transfer' | 'scrap'
type OperateDocType = '门店报货' | '分院调货出库' | '院退货' | '院产品报损'

interface Category {
  key: CategoryKey
  title: string
  desc: string
  icon: string
  color: string
}

interface Operation {
  docType: OperateDocType
  title: string
  desc: string
  icon: string
  color: string
}

const CATEGORIES: Category[] = [
  { key: 'stocks', title: '实时库存', desc: '本店产品 / 批号 / 数量', icon: 'balance-list-o', color: '#C0322A' },
  { key: 'procurement', title: '报货与收货', desc: '门店报货 / 分院配货', icon: 'add-o', color: '#3D8A5A' },
  { key: 'sale', title: '退货记录', desc: '院退货 / 顾客退货', icon: 'shop-o', color: '#5E8BB3' },
  { key: 'transfer', title: '门店调货', desc: '同市场门店调货', icon: 'exchange', color: '#9061C2' },
  { key: 'scrap', title: '报损记录', desc: '产品损耗 / 异常', icon: 'warning-o', color: '#D4820A' },
]

const OPERATIONS: Operation[] = [
  { docType: '门店报货', title: '门店报货', desc: '选择可报货产品和数量', icon: 'add-o', color: '#3D8A5A' },
  { docType: '分院调货出库', title: '同市场调货', desc: '向同市场门店发起调货', icon: 'exchange', color: '#9061C2' },
  { docType: '院退货', title: '院退货', desc: '提交待审批的退货单', icon: 'revoke', color: '#5E8BB3' },
  { docType: '院产品报损', title: '产品报损', desc: '登记异常损耗和原因', icon: 'warning-o', color: '#D4820A' },
]

Page({
  data: {
    categories: CATEGORIES,
    operations: OPERATIONS,
  },
  onCategoryTap(e: WechatMiniprogram.CustomEvent) {
    const key = e.currentTarget.dataset.key as CategoryKey
    if (!key) return
    if (key === 'stocks') {
      wx.navigateTo({ url: '/packageMy/inventory/stocks' })
      return
    }
    wx.navigateTo({ url: `/packageMy/inventory/list?docCategory=${key}` })
  },
  onOperationTap(e: WechatMiniprogram.CustomEvent) {
    const docType = e.currentTarget.dataset.docType as OperateDocType
    if (!docType) return
    wx.navigateTo({
      url: `/packageMy/inventory/form?docType=${encodeURIComponent(docType)}`,
    })
  },
  onPendingReceiveTap() {
    wx.navigateTo({ url: '/packageMy/inventory/list?docCategory=procurement&status=%E5%BE%85%E6%94%B6%E8%B4%A7' })
  },
})
