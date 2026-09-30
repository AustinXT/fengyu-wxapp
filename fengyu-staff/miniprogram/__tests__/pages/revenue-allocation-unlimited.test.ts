import { afterAll, beforeAll, beforeEach, describe, expect, test, vi } from 'vitest'
import { callStaffApi } from '../../utils/cloud'

vi.mock('../../utils/cloud', () => ({ callStaffApi: vi.fn() }))
vi.mock('../../utils/role', () => ({ requireManager: () => true }))

let definition: Record<string, any>
let originalPage: unknown

const items = [
  { sale_item_id: 'item-1', sku_id: 'sku-1', product_name: '疗程卡', product_type: '疗程卡', received: '100.00', sales_category: '自销自耗', item_direction: '购买' },
  { sale_item_id: 'item-2', sku_id: 'sku-1', product_name: '疗程卡', product_type: '疗程卡', received: '80.00', sales_category: '自销自耗', item_direction: '购买' },
]
const employees = ['EMP-1', 'EMP-2', 'EMP-3', 'EMP-4']

function createPage() {
  const page = { ...definition, data: JSON.parse(JSON.stringify(definition.data)) } as Record<string, any>
  page.data.salePaymentId = 7
  page.data.candidateEmployees = employees.map((staffWfId) => ({ staffWfId, name: staffWfId, skills: ['养生师'], assignmentScope: 'local' }))
  page.setData = (update: Record<string, unknown>) => {
    for (const [path, value] of Object.entries(update)) {
      const parts = path.replace(/\[(\d+)\]/g, '.$1').split('.')
      let target = page.data
      for (const part of parts.slice(0, -1)) target = target[part]
      target[parts[parts.length - 1]] = value
    }
  }
  return page
}

function existing(ratio = 0.25) {
  return items.flatMap((item) => employees.map((employeeId) => ({
    sale_item_id: item.sale_item_id,
    employee_id: employeeId,
    employee_name: employeeId,
    role_type: '养生师',
    allocation_ratio: ratio,
    is_void: false,
  })))
}

beforeAll(async () => {
  originalPage = (globalThis as any).Page
  ;(globalThis as any).Page = (page: Record<string, any>) => { definition = page }
  await import('../../packageOrder/revenue-allocation/revenue-allocation')
})

afterAll(() => {
  ;(globalThis as any).Page = originalPage
  vi.useRealTimers()
})

beforeEach(() => {
  vi.clearAllMocks()
  vi.useFakeTimers()
  wx.showToast = vi.fn()
  wx.navigateBack = vi.fn()
})

describe('回款营业额分配同池不限人数', () => {
  test('从空白分配逐行添加至第 5 人，选择技能、员工和自定义 20% 后保存', async () => {
    const page = createPage()
    const fiveEmployees = [...employees, 'EMP-5']
    page.data.candidateEmployees = fiveEmployees.map((staffWfId) => ({
      staffWfId, name: staffWfId, skills: ['养生师'], assignmentScope: 'local',
    }))
    page.restoreAllocations([], items)
    for (const [index, employeeId] of fiveEmployees.entries()) {
      page.onAddLine({ currentTarget: { dataset: { itemIdx: 0 } } })
      page.setData({ pickerItemIdx: 0, pickerLineIdx: index })
      page.onSkillSelect({ detail: { name: '养生师' } })
      page.openEmployeePicker({ currentTarget: { dataset: { itemIdx: 0, lineIdx: index } } })
      expect(page.data.empPopupList).toHaveLength(5)
      page.onEmployeeSelect({ currentTarget: { dataset: { staffWfId: employeeId, name: employeeId } } })
      page.setData({ customRatioInput: '20' })
      page.onConfirmCustomRatio()
    }
    expect(page.data.displayItems[0].allocLines).toHaveLength(5)
    expect(page.data.displayItems[0].allocLines.map((line: any) => line.allocAmount)).toEqual([
      '36.00', '36.00', '36.00', '36.00', '36.00',
    ])
    vi.mocked(callStaffApi).mockResolvedValueOnce({})
    await page.onSave()
    expect(callStaffApi).toHaveBeenCalledWith('allocation.savePayment', {
      salePaymentId: 7,
      allocations: fiveEmployees.flatMap((employeeId) => items.map((item) => ({
        saleItemId: item.sale_item_id, employeeId, roleType: '养生师', allocationRatio: 0.2,
      }))),
    })
  })

  test('两个同 SKU 实例的 4 人历史分配完整回显，重新保存展开为 8 行', async () => {
    const page = createPage()
    page.restoreAllocations(existing(), items)

    expect(page.data.displayItems).toHaveLength(1)
    expect(page.data.displayItems[0].allocLines.map((line: any) => [line.staffWfId, line.ratioPercent, line.allocAmount])).toEqual([
      ['EMP-1', 25, '45.00'], ['EMP-2', 25, '45.00'], ['EMP-3', 25, '45.00'], ['EMP-4', 25, '45.00'],
    ])

    vi.mocked(callStaffApi).mockResolvedValueOnce({})
    await page.onSave()

    expect(callStaffApi).toHaveBeenCalledWith('allocation.savePayment', {
      salePaymentId: 7,
      allocations: employees.flatMap((employeeId) => items.map((item) => ({
        saleItemId: item.sale_item_id, employeeId, roleType: '养生师', allocationRatio: 0.25,
      }))),
    })
    expect(wx.showToast).toHaveBeenCalledWith({ title: '分配已保存', icon: 'success' })
  })

  test('4 人比例总和超 100% 仍在提交前被拦截', async () => {
    const page = createPage()
    page.restoreAllocations(existing(0.3), items)
    await page.onSave()

    expect(callStaffApi).not.toHaveBeenCalled()
    expect(wx.showToast).toHaveBeenCalledWith({ title: '同技能标签分配比例合计超过 100%', icon: 'none' })
  })
})
