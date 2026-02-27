// mock/auth.ts — 认证相关 mock
import type { } from '../typings/index'

export const authHandlers: Record<string, (payload: Record<string, any>) => any> = {
  'auth.login': () => ({
    userId: 'mock-staff-001',
    staffWfId: 'WF-00001',
    staffName: '王店长',
    position: '门店经理',
    phone: '13800000001',
    boundStoreName: '南商市场·凤御旗舰店',
    boundStoreId: 'store-001',
  }),

  'auth.bindPhone': (payload) => ({
    userId: 'mock-staff-001',
    staffWfId: 'WF-00001',
    staffName: '王店长',
    position: '门店经理',
    phone: payload.phone || '13800000001',
    boundStoreName: '南商市场·凤御旗舰店',
    boundStoreId: 'store-001',
  }),
}
