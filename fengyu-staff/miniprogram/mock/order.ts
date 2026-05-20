// mock/order.ts — 订单相关 mock

const MOCK_ORDERS = [
  {
    id: 'order-001',
    saleOrderId: 'FY-XSD-WX-260205001',
    customerName: '张美玲',
    customerPhone: '13888880000',
    customerPhoneMasked: '138****8000',
    clientUserId: 'client-wx-001',
    status: '已支付',
    orderType: 'normal',
    payType: '微信',
    totalAmount: '5000.00',
    paidAmount: '5000.00',
    createdBy: 'manager',
    createdByName: '王店长',
    confirmedBy: null as string | null,
    paidAt: '2026-02-05 14:32',
    createdAt: '2026-02-05 14:10',
    remark: '',
    items: [
      {
        saleItemId: 'XSLSH-WX-20260205001',
        itemName: '蜜语精华护理疗程',
        spec: '10次卡',
        unitPrice: '3800.00',
        quantity: 1,
        totalPrice: '3800.00',
        sessionCount: 10,
        remainingSessions: 8,
      },
      {
        saleItemId: 'XSLSH-WX-20260205002',
        itemName: '安吉丽眼部护理',
        spec: '单品',
        unitPrice: '1200.00',
        quantity: 1,
        totalPrice: '1200.00',
        sessionCount: 1,
        remainingSessions: 1,
      },
    ],
    allocation: [
      { staffName: '李芳芳', department: '美容部', amount: '3500.00', ratio: '70%' },
      { staffName: '王晓梅', department: '美容部', amount: '1500.00', ratio: '30%' },
    ],
  },
  {
    id: 'order-002',
    saleOrderId: 'FY-XSD-WX-260227001',
    customerName: '王芳',
    customerPhone: '13955550000',
    customerPhoneMasked: '139****5000',
    clientUserId: 'client-wx-002',
    status: '待支付',
    orderType: 'normal',
    payType: '线下',
    totalAmount: '3200.00',
    paidAmount: '3200.00',
    createdBy: 'manager',
    createdByName: '王店长',
    confirmedBy: null as string | null,
    paidAt: null as string | null,
    createdAt: '2026-02-27 13:45',
    remark: '',
    items: [
      {
        saleItemId: 'XSLSH-WX-20260210001',
        itemName: '明眸祛皱疗程',
        spec: '单品',
        unitPrice: '3200.00',
        quantity: 1,
        totalPrice: '3200.00',
        sessionCount: 1,
        remainingSessions: 1,
      },
    ],
    allocation: [],
  },
  {
    id: 'order-003',
    saleOrderId: 'FY-XSD-WX-260220001',
    customerName: '李晓华',
    customerPhone: '13622230000',
    customerPhoneMasked: '136****3000',
    clientUserId: null,
    status: '待支付',
    orderType: 'normal',
    payType: null,
    totalAmount: '2800.00',
    paidAmount: null,
    createdBy: 'manager',
    createdByName: '王店长',
    confirmedBy: null as string | null,
    paidAt: null as string | null,
    createdAt: '2026-02-20 11:20',
    remark: '',
    items: [
      {
        saleItemId: 'XSLSH-WX-20260220001',
        itemName: '光感白皙嫩肤疗程',
        spec: '5次卡',
        unitPrice: '2800.00',
        quantity: 1,
        totalPrice: '2800.00',
        sessionCount: 5,
        remainingSessions: 5,
      },
    ],
    allocation: [],
  },
]

let qrcodeStatus = '待扫码'

export const orderHandlers: Record<string, (payload: Record<string, any>) => any> = {
  'order.list': (payload) => {
    let list = [...MOCK_ORDERS]
    if (payload.status) {
      if (payload.status === 'pendingOffline') {
        list = list.filter(o => o.status === '待支付' && o.payType === '线下')
      } else if (payload.status === 'pendingCreate') {
        list = list.filter(o => o.status === '待支付')
      } else {
        list = list.filter(o => o.status === payload.status)
      }
    }
    return list
  },

  'order.detail': (payload) => {
    return MOCK_ORDERS.find(o => o.id === payload.orderId || o.saleOrderId === payload.saleOrderId) || MOCK_ORDERS[0]
  },

  'order.create': (payload) => ({
    orderId: 'order-new-001',
    saleOrderId: 'FY-XSD-WX-260227099',
    status: '待支付',
    ...payload,
  }),

  'order.qrcode': (payload) => {
    const order = MOCK_ORDERS.find(o => o.id === payload.orderId) || MOCK_ORDERS[1]
    return {
      orderId: order.id,
      saleOrderId: order.saleOrderId,
      customerName: order.customerName,
      totalAmount: order.totalAmount,
      status: qrcodeStatus,
      qrcodeUrl: 'https://placeholder.com/qrcode.png',
    }
  },

  'order.confirmOffline': (payload) => {
    const order = MOCK_ORDERS.find(o => o.id === payload.orderId || o.saleOrderId === payload.saleOrderId)
    if (order) {
      order.status = '已支付'
      order.paidAt = new Date().toISOString().slice(0, 16).replace('T', ' ')
    }
    return { success: true }
  },

  'order.close': (payload) => {
    const order = MOCK_ORDERS.find(o => o.id === payload.orderId)
    if (order) order.status = '已关闭'
    return { success: true }
  },

  'order.resetFailed': (payload) => {
    const order = MOCK_ORDERS.find(o => o.id === payload.orderId)
    if (order) order.status = '待支付'
    return { success: true }
  },
}
