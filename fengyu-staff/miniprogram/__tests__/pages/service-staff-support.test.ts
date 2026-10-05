import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../../utils/cloud', () => ({ callStaffApi: vi.fn() }))
let definition: any
let globalData: any

async function page(module: string) {
  vi.stubGlobal('Page', (value: any) => { definition = value })
  if (module === 'service') await import('../../packageService/service-create/service-create')
  else if (module === 'revenue') await import('../../packageOrder/revenue-allocation/revenue-allocation')
  else await import('../../packageOrder/service-commission/service-commission')
  return { ...definition, data: JSON.parse(JSON.stringify(definition.data)),
    setData(update: any) { Object.assign(this.data, update) } }
}

beforeEach(() => {
  vi.resetModules()
  vi.clearAllMocks()
  globalData = { currentStoreId: 'A', staffWfId: 'self', staffName: '本人', managerStoreIds: ['A', 'B'] }
  vi.stubGlobal('getApp', () => ({ globalData }))
  vi.stubGlobal('wx', { showToast: vi.fn() })
})

const staff = (id: string, scope = 'local', skills = ['店经理']) => ({ staffWfId: id, name: id,
  assignmentScope: scope, skills, department: '部门', marketName: '品项公司', storeName: '' })

describe('服务单人员刷新', () => {
  it('切店先后响应倒序时只接纳当前门店，失效选择清空', async () => {
    const { callStaffApi } = await import('../../utils/cloud')
    const p = await page('service')
    let resolveA!: (value: any) => void
    let resolveB!: (value: any) => void
    vi.mocked(callStaffApi)
      .mockReturnValueOnce(new Promise(resolve => { resolveA = resolve }))
      .mockReturnValueOnce(new Promise(resolve => { resolveB = resolve }))
    p.data.assignedStaffWfId = 'old'
    const first = p.loadStaffList()
    globalData.currentStoreId = 'B'
    const second = p.loadStaffList()
    resolveB({ staffList: [staff('teacher', 'cross_market_trip', ['品项老师'])] })
    await second
    resolveA({ staffList: [staff('old')] })
    await first
    expect(p.data.staffStoreId).toBe('B')
    expect(p.data.staffList.map((s: any) => s.staffWfId)).toEqual(['teacher'])
    expect(p.data.assignedStaffWfId).toBe('')
    expect(p.data.staffColumns[0]).toContain('外援·品项公司')
    expect(callStaffApi).toHaveBeenLastCalledWith('staff.list', { scene: 'service', storeId: 'B' })
  })

  it('同店刷新保留有效人选，技能/支援资格失效或请求失败清空', async () => {
    const { callStaffApi } = await import('../../utils/cloud')
    const p = await page('service')
    p.data.staffStoreId = 'A'
    p.data.assignedStaffWfId = 'teacher'
    vi.mocked(callStaffApi).mockResolvedValueOnce({ staffList: [staff('teacher')] })
    await p.loadStaffList()
    expect(p.data.assignedStaffWfId).toBe('teacher')
    vi.mocked(callStaffApi).mockResolvedValueOnce({ staffList: [] })
    await p.loadStaffList()
    expect(p.data.assignedStaffWfId).toBe('')
    p.data.assignedStaffWfId = 'teacher'
    vi.mocked(callStaffApi).mockRejectedValueOnce(new Error('失败'))
    await p.loadStaffList()
    expect(p.data.assignedStaffWfId).toBe('')
    expect(p.data.loadingStaff).toBe(false)
  })

  it('切店后旧候选不能确认或提交', async () => {
    const { callStaffApi } = await import('../../utils/cloud')
    const p = await page('service')
    Object.assign(p.data, { isManager: true, staffStoreId: 'A', staffList: [staff('old')],
      assignedStaffWfId: 'old', selectedCustomer: { id: 'C' }, selectedItems: [{}] })
    globalData.currentStoreId = 'B'
    p.onStaffConfirm({ detail: { index: 0 } })
    await p.onSubmit()
    expect(callStaffApi).not.toHaveBeenCalled()
    expect(wx.showToast).toHaveBeenCalledWith(expect.objectContaining({ title: '请重新选择当前门店的服务人员' }))
  })
})

it.each(['revenue', 'commission'])('%s 动态四角色与推广保留，按技能筛选本店排前', async (module) => {
  const { callStaffApi } = await import('../../utils/cloud')
  const p = await page(module)
  const roles = ['店经理', '美容师', '养生师', '品项老师', '推广师']
  const candidates = roles.flatMap(role => [staff(`trip-${role}`, 'cross_market_trip', [role]), staff(`local-${role}`, 'local', [role])])
  vi.mocked(callStaffApi).mockImplementation(async (action: string) => action === 'staff.skillTags'
    ? { skillTags: roles } : { order: { commission_status: '待分配' }, items: [], allocLines: [], candidateEmployees: candidates })
  await p.init(module === 'revenue' ? 1 : 'S1')
  expect(p.data.skillSheetActions.map((s: any) => s.name)).toEqual(roles)
  for (const role of roles) {
    expect(p.getFilteredEmployees(role).map((e: any) => e.staffWfId)).toEqual([`local-${role}`, `trip-${role}`])
  }
})
