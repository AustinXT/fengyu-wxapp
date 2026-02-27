// mock/store.ts — 门店和员工相关 mock

const MOCK_STORES = [
  { storeId: 'store-001', storeName: '南商市场·凤御旗舰店' },
  { storeId: 'store-002', storeName: '华联商场·凤御分店' },
  { storeId: 'store-003', storeName: '万达广场·凤御分店' },
]

const MOCK_STAFF = [
  {
    staffWfId: 'WF-00001',
    staffName: '王店长',
    role: 'manager',
    department: '管理部',
    storeId: 'store-001',
    isAllocatable: true,
    phone: '13800000001',
  },
  {
    staffWfId: 'WF-00002',
    staffName: '李芳芳',
    role: 'beautician',
    department: '美容部',
    storeId: 'store-001',
    isAllocatable: true,
    phone: '13800000002',
  },
  {
    staffWfId: 'WF-00003',
    staffName: '王晓梅',
    role: 'beautician',
    department: '美容部',
    storeId: 'store-001',
    isAllocatable: true,
    phone: '13800000003',
  },
  {
    staffWfId: 'WF-00004',
    staffName: '刘美华',
    role: 'beautician',
    department: '推广部',
    storeId: 'store-001',
    isAllocatable: true,
    phone: '13800000004',
  },
]

const MOCK_DEPARTMENTS = [
  { departmentId: 'dept-01', departmentName: '美容部' },
  { departmentId: 'dept-02', departmentName: '推广部' },
  { departmentId: 'dept-03', departmentName: '管理部' },
]

export const storeHandlers: Record<string, (payload: Record<string, any>) => any> = {
  'store.list': () => MOCK_STORES,

  'staff.list': (payload) => {
    let list = MOCK_STAFF.filter(s => s.storeId === (payload.storeId || 'store-001'))
    if (payload.isAllocatable) {
      list = list.filter(s => s.isAllocatable)
    }
    if (payload.departmentId) {
      list = list.filter(s => s.department === payload.departmentId)
    }
    return list
  },

  'staff.departments': () => MOCK_DEPARTMENTS,

  'staff.bindStore': (payload) => {
    const store = MOCK_STORES.find(s => s.storeId === payload.storeId)
    return { success: true, storeName: store?.storeName || '' }
  },
}
