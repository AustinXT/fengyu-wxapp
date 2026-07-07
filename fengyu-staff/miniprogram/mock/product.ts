

const MOCK_CATEGORIES = [
  { id: 'cat-01', name: '蜜语生玑', big_category: '生美', category_order: 1 },
  { id: 'cat-02', name: '安吉丽美颜之爱', big_category: '生美', category_order: 2 },
  { id: 'cat-03', name: '光感白皙', big_category: '生美', category_order: 3 },
  { id: 'cat-04', name: '眉眼', big_category: '非生美', category_order: 4 },
  { id: 'cat-05', name: '身体护理', big_category: '非生美', category_order: 5 },
  { id: 'cat-06', name: '家居产品', big_category: '家居产品', category_order: 6 },
]

const MOCK_SPUS: Record<string, any[]> = {
  'cat-01': [
    {
      spuId: 'spu-001',
      spuName: '蜜语精华护理疗程',
      categoryName: '蜜语生玑',
      productType: '疗程卡',
      priceFrom: 3800,
      cover_image: '',
      skus: [
        { skuId: 'sku-001', specName: '10次卡', price: 3800, sessionCount: 10, workfineItemId: 'WF-1001' },
        { skuId: 'sku-002', specName: '20次卡', price: 6800, sessionCount: 20, workfineItemId: 'WF-1002' },
        { skuId: 'sku-003', specName: '单次', price: 480, sessionCount: 1, workfineItemId: 'WF-1003' },
      ],
    },
    {
      spuId: 'spu-002',
      spuName: '蜜语焕颜精华护理',
      categoryName: '蜜语生玑',
      productType: '疗程卡',
      priceFrom: 4200,
      cover_image: '',
      skus: [
        { skuId: 'sku-004', specName: '10次卡', price: 4200, sessionCount: 10, workfineItemId: 'WF-1004' },
        { skuId: 'sku-005', specName: '单次', price: 520, sessionCount: 1, workfineItemId: 'WF-1005' },
      ],
    },
  ],
  'cat-02': [
    {
      spuId: 'spu-003',
      spuName: '安吉丽美颜之爱疗程',
      categoryName: '安吉丽美颜之爱',
      productType: '疗程卡',
      priceFrom: 3600,
      cover_image: '',
      skus: [
        { skuId: 'sku-006', specName: '10次卡', price: 3600, sessionCount: 10, workfineItemId: 'WF-2001' },
        { skuId: 'sku-007', specName: '单次', price: 450, sessionCount: 1, workfineItemId: 'WF-2002' },
      ],
    },
  ],
  'cat-03': [
    {
      spuId: 'spu-006',
      spuName: '光感白皙美白疗程',
      categoryName: '光感白皙',
      productType: '疗程卡',
      priceFrom: 3200,
      cover_image: '',
      skus: [
        { skuId: 'sku-011', specName: '10次卡', price: 3200, sessionCount: 10, workfineItemId: 'WF-4001' },
        { skuId: 'sku-012', specName: '单次', price: 420, sessionCount: 1, workfineItemId: 'WF-4002' },
      ],
    },
    {
      spuId: 'spu-007',
      spuName: '光感净肤焕白精华',
      categoryName: '光感白皙',
      productType: '疗程卡',
      priceFrom: 2800,
      cover_image: '',
      skus: [
        { skuId: 'sku-013', specName: '10次卡', price: 2800, sessionCount: 10, workfineItemId: 'WF-4003' },
        { skuId: 'sku-014', specName: '20次卡', price: 4800, sessionCount: 20, workfineItemId: 'WF-4004' },
      ],
    },
  ],
  'cat-04': [
    {
      spuId: 'spu-004',
      spuName: '明眸祛皱疗程',
      categoryName: '眉眼',
      productType: '疗程卡',
      priceFrom: 1200,
      cover_image: '',
      skus: [
        { skuId: 'sku-008', specName: '单次', price: 1200, sessionCount: 1, workfineItemId: 'WF-3001' },
      ],
    },
    {
      spuId: 'spu-005',
      spuName: '眉眼提升疗程',
      categoryName: '眉眼',
      productType: '疗程卡',
      priceFrom: 2800,
      cover_image: '',
      skus: [
        { skuId: 'sku-009', specName: '10次卡', price: 2800, sessionCount: 10, workfineItemId: 'WF-3002' },
        { skuId: 'sku-010', specName: '20次卡', price: 4800, sessionCount: 20, workfineItemId: 'WF-3003' },
      ],
    },
  ],
  'cat-05': [
    {
      spuId: 'spu-008',
      spuName: '全身精油SPA疗程',
      categoryName: '身体护理',
      productType: '疗程卡',
      priceFrom: 2600,
      cover_image: '',
      skus: [
        { skuId: 'sku-015', specName: '10次卡', price: 2600, sessionCount: 10, workfineItemId: 'WF-5001' },
        { skuId: 'sku-016', specName: '单次', price: 380, sessionCount: 1, workfineItemId: 'WF-5002' },
      ],
    },
    {
      spuId: 'spu-009',
      spuName: '经络疏通养护',
      categoryName: '身体护理',
      productType: '疗程卡',
      priceFrom: 1800,
      cover_image: '',
      skus: [
        { skuId: 'sku-017', specName: '10次卡', price: 1800, sessionCount: 10, workfineItemId: 'WF-5003' },
        { skuId: 'sku-018', specName: '20次卡', price: 3200, sessionCount: 20, workfineItemId: 'WF-5004' },
        { skuId: 'sku-019', specName: '单次', price: 260, sessionCount: 1, workfineItemId: 'WF-5005' },
      ],
    },
  ],
  'cat-06': [
    {
      spuId: 'spu-010',
      spuName: '蜜语焕颜精华液',
      categoryName: '家居产品',
      productType: '家居产品',
      priceFrom: 680,
      cover_image: '',
      skus: [
        { skuId: 'sku-020', specName: '50ml', price: 680, sessionCount: 0, workfineItemId: 'WF-P001' },
        { skuId: 'sku-021', specName: '100ml', price: 1180, sessionCount: 0, workfineItemId: 'WF-P002' },
      ],
    },
    {
      spuId: 'spu-011',
      spuName: '安吉丽眼霜',
      categoryName: '家居产品',
      productType: '家居产品',
      priceFrom: 520,
      cover_image: '',
      skus: [
        { skuId: 'sku-022', specName: '30g', price: 520, sessionCount: 0, workfineItemId: 'WF-P003' },
      ],
    },
  ],
}

const MOCK_PROMO_PLANS = [
  {
    id: 'promo-001',
    name: '双十一焕肤套餐',
    validUntil: '2026-12-31',
    originalPrice: 12800,
    promoPrice: 9800,
    items: [
      { itemId: 'pi-001', itemName: '蜜语精华护理疗程', specName: '10次卡', originalPrice: 3800, promoPrice: 3200, isGift: false, skuId: 'sku-001', workfineItemId: 'WF-1001', sessionCount: 10, productType: '疗程卡' },
      { itemId: 'pi-002', itemName: '安吉丽美颜之爱疗程', specName: '10次卡', originalPrice: 3600, promoPrice: 3000, isGift: false, skuId: 'sku-006', workfineItemId: 'WF-2001', sessionCount: 10, productType: '疗程卡' },
      { itemId: 'pi-003', itemName: '明眸祛皱疗程', specName: '单次', originalPrice: 1200, promoPrice: 0, isGift: true, skuId: 'sku-008', workfineItemId: 'WF-3001', sessionCount: 1, productType: '疗程卡' },
      { itemId: 'pi-004', itemName: '蜜语焕颜精华液', specName: '50ml', originalPrice: 680, promoPrice: 0, isGift: true, skuId: 'sku-020', workfineItemId: 'WF-P001', sessionCount: 0, productType: '家居产品' },
    ],
  },
  {
    id: 'promo-002',
    name: '新客首购礼遇套餐',
    validUntil: '2026-12-31',
    originalPrice: 5200,
    promoPrice: 3800,
    items: [
      { itemId: 'pi-005', itemName: '蜜语焕颜精华护理', specName: '10次卡', originalPrice: 4200, promoPrice: 3800, isGift: false, skuId: 'sku-004', workfineItemId: 'WF-1004', sessionCount: 10, productType: '疗程卡' },
      { itemId: 'pi-006', itemName: '蜜语焕颜精华液', specName: '50ml', originalPrice: 680, promoPrice: 0, isGift: true, skuId: 'sku-020', workfineItemId: 'WF-P001', sessionCount: 0, productType: '家居产品' },
    ],
  },
  {
    id: 'promo-003',
    name: '年终美丽答谢套餐',
    validUntil: '2026-03-31',
    originalPrice: 8800,
    promoPrice: 6800,
    items: [
      { itemId: 'pi-007', itemName: '蜜语精华护理疗程', specName: '20次卡', originalPrice: 6800, promoPrice: 5800, isGift: false, skuId: 'sku-002', workfineItemId: 'WF-1002', sessionCount: 20, productType: '疗程卡' },
      { itemId: 'pi-008', itemName: '眉眼提升疗程', specName: '10次卡', originalPrice: 2800, promoPrice: 1000, isGift: false, skuId: 'sku-009', workfineItemId: 'WF-3002', sessionCount: 10, productType: '疗程卡' },
    ],
  },
]

export const productHandlers: Record<string, (payload: Record<string, any>) => any> = {
  'product.shopInit': () => {
    const firstCat = MOCK_CATEGORIES[0]
    return {
      categories: MOCK_CATEGORIES,
      skuList: firstCat ? (MOCK_SPUS[firstCat.id] || []) : [],
    }
  },

  'product.categories': () => MOCK_CATEGORIES,

  'product.skuList': (payload) => {
    const catId = payload.categoryId
    return MOCK_SPUS[catId] || []
  },

  'product.skuDetail': (payload) => {
    for (const spus of Object.values(MOCK_SPUS)) {
      for (const spu of spus) {
        if (spu.spuId === payload.spuId) return spu
      }
    }
    return null
  },

  'product.promotionPlans': () => MOCK_PROMO_PLANS,

  'product.promotionPlanDetail': (payload) => {
    return MOCK_PROMO_PLANS.find(p => p.id === payload.planId) || null
  },
}
