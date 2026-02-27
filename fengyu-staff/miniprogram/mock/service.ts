// mock/service.ts — 服务单相关 mock

const MOCK_SERVICES = [
  {
    id: 'svc-001',
    serviceNo: 'HLD-WX-260227001',
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
        itemFlowNo: 'XSLSH-WX-20260205001',
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
    serviceNo: 'HLD-WX-260227002',
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
        itemFlowNo: 'XSLSH-WX-20260210001',
        itemName: '明眸祛皱疗程',
        spec: '单品',
        sessionCount: 1,
        remainingSessions: 0,
        totalSessions: 1,
      },
    ],
  },
  {
    id: 'svc-003',
    serviceNo: 'HLD-WX-260226001',
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
        itemFlowNo: 'XSLSH-WX-20260120001',
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
    serviceNo: 'HLD-WX-260225001',
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
        itemFlowNo: 'XSLSH-WX-20260205001',
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
    if (status) {
      return MOCK_SERVICES.filter(s => s.status === status)
    }
    return MOCK_SERVICES
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
    serviceNo: 'HLD-WX-260227099',
    status: '待服务',
    ...payload,
  }),
}
