// packageMy/inventory/inventory.ts — 库存管理首页（4 类入口）

interface Category {
  key: 'procurement' | 'sale' | 'transfer' | 'scrap'
  title: string
  desc: string
  icon: string
  color: string
}

const CATEGORIES: Category[] = [
  { key: 'procurement', title: '采购入库', desc: '院报货 / 院入库 / 退货', icon: 'add-o', color: '#3D8A5A' },
  { key: 'sale', title: '销售出库', desc: '销售出库 / 顾客退货', icon: 'shop-o', color: '#5E8BB3' },
  { key: 'transfer', title: '门店调拨', desc: '调拨出/入库', icon: 'exchange', color: '#9061C2' },
  { key: 'scrap', title: '报损出库', desc: '产品损耗 / 异常', icon: 'warning-o', color: '#D4820A' },
]

Page({
  data: {
    categories: CATEGORIES,
  },
  onCategoryTap(e: WechatMiniprogram.CustomEvent) {
    const key = e.currentTarget.dataset.key as Category['key']
    if (!key) return
    wx.navigateTo({ url: `/packageMy/inventory/list?docCategory=${key}` })
  },
})
