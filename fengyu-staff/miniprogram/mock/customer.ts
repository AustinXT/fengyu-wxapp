// mock/customer.ts — 顾客相关 mock

const MOCK_CUSTOMERS = [
  {
    id: 'client-001',
    clientUserId: 'client-wx-001',
    name: '张美玲',
    phone: '13888880000',
    phoneMasked: '138****8000',
    memberLevel: 'VIP',
    preferredStaffName: '李芳芳',
    skinType: '干性',
    focusAreas: '色斑、细纹',
    totalConsumption: 128600,
    yearConsumption: 18500,
    totalActualConsumption: 72600,
    yearActualConsumption: 10600,
  },
  {
    id: 'client-002',
    clientUserId: 'client-wx-002',
    name: '王芳',
    phone: '13955550000',
    phoneMasked: '139****5000',
    memberLevel: '普通',
    preferredStaffName: '李芳芳',
    skinType: '油性',
    focusAreas: '毛孔、痘印',
    totalConsumption: 45200,
    yearConsumption: 8800,
    totalActualConsumption: 26700,
    yearActualConsumption: 5300,
  },
  {
    id: null,
    clientUserId: 'client-wx-003',
    name: '李晓华',
    phone: '13622230000',
    phoneMasked: '136****3000',
    memberLevel: '普通',
    preferredStaffName: null,
    skinType: '混合性',
    focusAreas: '补水、嫩肤',
    totalConsumption: 12000,
    yearConsumption: 12000,
    totalActualConsumption: 6400,
    yearActualConsumption: 6400,
  },
]

// 顾客的已支付订单（用于创建服务单时选择）
const MOCK_CUSTOMER_ORDERS: Record<string, any[]> = {
  'client-001': [
    {
      orderId: 'order-001',
      saleOrderId: 'FY-XSD-WX-260205001',
      status: '已支付',
      paidAt: '2026-02-05',
      items: [
        {
          saleItemId: 'XSLSH-WX-20260205001',
          itemName: '蜜语精华护理疗程',
          spec: '10次卡',
          sessionCount: 10,
          remainingSessions: 8,
          productType: '疗程卡',
          unitRealPrice: '100.00',
        },
        {
          saleItemId: 'XSLSH-WX-20260205002',
          itemName: '安吉丽眼部护理',
          spec: '单次',
          sessionCount: 1,
          remainingSessions: 1,
          productType: '疗程卡',
          unitRealPrice: '100.00',
        },
      ],
    },
    {
      orderId: 'order-002',
      saleOrderId: 'FY-XSD-WX-260120001',
      status: '已支付',
      paidAt: '2026-01-20',
      items: [
        {
          saleItemId: 'XSLSH-WX-20260120001',
          itemName: '眉眼提升疗程',
          spec: '20次卡',
          sessionCount: 20,
          remainingSessions: 15,
          productType: '疗程卡',
          unitRealPrice: '100.00',
        },
      ],
    },
  ],
  'client-002': [
    {
      orderId: 'order-003',
      saleOrderId: 'FY-XSD-WX-260210001',
      status: '已支付',
      paidAt: '2026-02-10',
      items: [
        {
          saleItemId: 'XSLSH-WX-20260210001',
          itemName: '明眸祛皱疗程',
          spec: '单次',
          sessionCount: 1,
          remainingSessions: 1,
          productType: '疗程卡',
          unitRealPrice: '100.00',
        },
      ],
    },
  ],
}

export const customerHandlers: Record<string, (payload: Record<string, any>) => any> = {
  'customer.search': (payload) => {
    // 手机号精确匹配（pickup 数字输入用）
    const phone = (payload.phone || '').replace(/\s/g, '')
    if (phone) {
      const found = MOCK_CUSTOMERS.find(c => c.phone === phone)
      return found ? [found] : []
    }
    // 关键词模糊匹配手机号 + 姓名（开单 / 充值卡 / 顾客 Tab / 服务单用；crossStore 在 mock 中无意义）
    const keyword = (payload.keyword || '').trim()
    if (keyword) {
      return MOCK_CUSTOMERS.filter(
        c => (c.phone || '').includes(keyword) || (c.name || '').includes(keyword),
      )
    }
    // 无入参时返回全部（默认列表）
    return MOCK_CUSTOMERS
  },

  'customer.calendar': (payload) => {
    const today = new Date()
    const defaultYm = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}`
    const yearMonth = payload.year_month || payload.yearMonth || defaultYm
    const days = ['05', '08', '12', '15', '19', '22']
    return days.map(d => ({
      date: `${yearMonth}-${d}`,
      amount: Math.floor(Math.random() * 5000 + 1000),
    }))
  },

  'customer.paidOrders': (payload) => {
    const orders = MOCK_CUSTOMER_ORDERS[payload.clientUserId] || []
    return orders
  },

  'customer.detail': (payload) => {
    return MOCK_CUSTOMERS.find(c => c.id === payload.id) || MOCK_CUSTOMERS[0]
  },
}
