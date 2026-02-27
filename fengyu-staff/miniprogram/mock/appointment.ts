// mock/appointment.ts — 预约相关 mock

const MOCK_APPOINTMENTS = [
  {
    id: 'appt-001',
    customerName: '张美玲',
    customerPhone: '138****8000',
    staffName: '李芳芳',
    appointmentTime: '2026-02-27 14:00',
    status: 'pending',
    statusText: '待确认',
    serviceItemName: '蜜语精华护理疗程',
    remark: '',
    serviceOrderId: null as string | null,
  },
  {
    id: 'appt-002',
    customerName: '王芳',
    customerPhone: '139****5000',
    staffName: '李芳芳',
    appointmentTime: '2026-02-28 10:00',
    status: 'confirmed',
    statusText: '已确认',
    serviceItemName: '安吉丽美颜之爱疗程',
    remark: '顾客要求早上到店',
    serviceOrderId: null as string | null,
  },
  {
    id: 'appt-003',
    customerName: '李晓华',
    customerPhone: '136****3000',
    staffName: '李芳芳',
    appointmentTime: '2026-02-27 15:30',
    status: 'pending',
    statusText: '待确认',
    serviceItemName: '眉眼提升疗程',
    remark: '',
    serviceOrderId: null as string | null,
  },
  {
    id: 'appt-004',
    customerName: '张美玲',
    customerPhone: '138****8000',
    staffName: '李芳芳',
    appointmentTime: '2026-02-25 15:00',
    status: 'completed',
    statusText: '已完成',
    serviceItemName: '蜜语精华护理疗程',
    remark: '',
    serviceOrderId: 'svc-004',
  },
]

export const appointmentHandlers: Record<string, (payload: Record<string, any>) => any> = {
  'appointment.list': (payload) => {
    let list = [...MOCK_APPOINTMENTS]
    if (payload.status && payload.status !== 'all') {
      list = list.filter(a => a.status === payload.status)
    }
    if (payload.todayOnly) {
      list = list.filter(a => a.appointmentTime.startsWith('2026-02-27'))
    }
    return list
  },

  'appointment.detail': (payload) => {
    return MOCK_APPOINTMENTS.find(a => a.id === payload.id) || MOCK_APPOINTMENTS[0]
  },

  'appointment.confirm': (payload) => {
    const appt = MOCK_APPOINTMENTS.find(a => a.id === payload.appointmentId)
    if (appt) {
      appt.status = 'confirmed'
      appt.statusText = '已确认'
    }
    return { success: true }
  },

  'appointment.checkin': (payload) => {
    return { success: true, checkinTime: new Date().toISOString() }
  },
}
