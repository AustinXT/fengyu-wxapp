// mock/service.ts — 服务单相关 mock

const MOCK_SERVICES = [
  {
    id: 'svc-001',
    serviceOrderId: 'HLD-WX-260227001',
    customerName: '张美玲',
    customerPhone: '138****8000',
    staffName: '李芳芳',
    assignedStaffWfId: 'WF-00001',
    status: '待服务',
    serviceTime: '2026-02-27 14:00',
    startTime: null as string | null,
    completedTime: null as string | null,
    appointmentId: 'appt-001',
    remark: '',
    items: [
      {
        saleItemId: 'XSLSH-WX-20260205001',
        itemName: '蜜语精华护理疗程',
        spec: '10次卡',
        sessionCount: 1,
        remainingSessions: 8,
        totalSessions: 10,
      },
    ],
  },
  {
    id: 'svc-002',
    serviceOrderId: 'HLD-WX-260227002',
    customerName: '王芳',
    customerPhone: '139****5000',
    staffName: '李芳芳',
    assignedStaffWfId: 'WF-00001',
    status: '服务中',
    serviceTime: '2026-02-27 13:00',
    startTime: '2026-02-27 13:05',
    completedTime: null as string | null,
    appointmentId: null,
    remark: '',
    items: [
      {
        saleItemId: 'XSLSH-WX-20260210001',
        itemName: '明眸祛皱疗程',
        spec: '单次',
        sessionCount: 1,
        remainingSessions: 0,
        totalSessions: 1,
      },
    ],
  },
  {
    id: 'svc-003',
    serviceOrderId: 'HLD-WX-260226001',
    customerName: '李晓华',
    customerPhone: '136****3000',
    staffName: '李芳芳',
    assignedStaffWfId: 'WF-00001',
    status: '已完成',
    serviceTime: '2026-02-26 10:00',
    startTime: '2026-02-26 10:05',
    completedTime: '2026-02-26 11:30',
    appointmentId: null,
    remark: '顾客反馈良好',
    items: [
      {
        saleItemId: 'XSLSH-WX-20260120001',
        itemName: '眉眼提升疗程',
        spec: '20次卡',
        sessionCount: 1,
        remainingSessions: 14,
        totalSessions: 20,
      },
    ],
  },
  {
    id: 'svc-004',
    serviceOrderId: 'HLD-WX-260225001',
    customerName: '张美玲',
    customerPhone: '138****8000',
    staffName: '李芳芳',
    assignedStaffWfId: 'WF-00001',
    status: '已完成',
    serviceTime: '2026-02-25 15:00',
    startTime: '2026-02-25 15:05',
    completedTime: '2026-02-25 16:20',
    appointmentId: 'appt-002',
    remark: '',
    items: [
      {
        saleItemId: 'XSLSH-WX-20260205001',
        itemName: '蜜语精华护理疗程',
        spec: '10次卡',
        sessionCount: 1,
        remainingSessions: 9,
        totalSessions: 10,
      },
    ],
  },
]

export const serviceHandlers: Record<string, (payload: Record<string, any>) => any> = {
  'service.list': (payload) => {
    const { status } = payload
    let list = [...MOCK_SERVICES]
    if (status) {
      list = list.filter(s => s.status === status)
    }
    const keyword = String(payload.keyword || '').trim().toLowerCase()
    if (keyword) {
      const phoneKeyword = keyword.replace(/\D/g, '')
      list = list.filter(s => s.customerName.toLowerCase().includes(keyword)
        || (!!phoneKeyword && s.customerPhone.replace(/\D/g, '').includes(phoneKeyword)))
    }
    if (payload.startDate) list = list.filter(s => s.serviceTime.slice(0, 10) >= payload.startDate)
    if (payload.endDate) list = list.filter(s => s.serviceTime.slice(0, 10) <= payload.endDate)
    list.sort((a, b) => b.serviceTime.localeCompare(a.serviceTime) || b.serviceOrderId.localeCompare(a.serviceOrderId))
    const page = Math.max(1, Number(payload.page) || 1)
    const pageSize = Math.max(1, Number(payload.pageSize) || 20)
    return list.slice((page - 1) * pageSize, page * pageSize)
  },

  'service.detail': (payload) => {
    return MOCK_SERVICES.find(s => s.id === payload.id) || MOCK_SERVICES[0]
  },

  'service.start': (payload) => {
    const svc = MOCK_SERVICES.find(s => s.id === payload.serviceOrderId)
    if (svc) {
      svc.status = '服务中'
      svc.startTime = new Date().toISOString().slice(0, 16).replace('T', ' ')
    }
    return { success: true }
  },

  'service.complete': (payload) => {
    const svc = MOCK_SERVICES.find(s => s.id === payload.serviceOrderId)
    if (svc) {
      svc.status = '已完成'
      svc.completedTime = new Date().toISOString().slice(0, 16).replace('T', ' ')
    }
    return { success: true }
  },

  'service.create': (payload) => ({
    id: 'svc-new-001',
    serviceOrderId: 'HLD-WX-260227099',
    status: '待服务',
    ...payload,
  }),
}
