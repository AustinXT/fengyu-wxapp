import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { ReactNode } from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { savePaymentAllocations } from '@/actions/allocations'
import { toast } from 'sonner'
import PaymentAllocationDetailPageClient from './payment-allocation-detail-page'

vi.mock('@/actions/allocations', () => ({ savePaymentAllocations: vi.fn() }))
vi.mock('sonner', () => ({ toast: { error: vi.fn(), success: vi.fn() } }))
vi.mock('next/link', () => ({ default: ({ children, href }: { children: ReactNode; href: string }) => <a href={href}>{children}</a> }))
vi.mock('@/components/return-context', () => ({
  ReturnContextLink: ({ children, href }: { children: ReactNode; href: string }) => <a href={href}>{children}</a>,
  useReturnContext: () => ({ goToReturn: vi.fn() }),
}))

const items = [
  { saleItemId: 'item-1', skuId: 'sku-1', productName: '疗程卡', productType: '疗程卡', allocatableAmount: 100, received: 100, salesCategory: '自销自耗', itemDirection: '购买', suggestedRate: 0 },
  { saleItemId: 'item-2', skuId: 'sku-1', productName: '疗程卡', productType: '疗程卡', allocatableAmount: 80, received: 80, salesCategory: '自销自耗', itemDirection: '购买', suggestedRate: 0 },
]
const employees = ['EMP-1', 'EMP-2', 'EMP-3', 'EMP-4']

function payment(ratio = '0.250') {
  return {
    salePaymentId: 7,
    saleOrderId: 'order-1',
    paymentAmount: 180,
    eventAmount: 180,
    paymentMethod: '线下',
    changeType: '回款',
    allocationStatus: '已分配',
    marketName: 'M',
    items,
    existingAllocations: items.flatMap((item) => employees.map((employeeId, index) => ({
      id: index + 1,
      saleItemId: item.saleItemId,
      employeeId,
      employeeName: employeeId,
      roleType: '养生师',
      allocationRatio: ratio,
      totalAmount: String(item.received * Number(ratio)),
    }))),
  }
}

describe('回款营业额分配页同池不限人数', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(savePaymentAllocations).mockResolvedValue({ success: true, message: '分配保存成功' })
  })

  it('从空白分配逐行添加至第 5 人，并经选择器提交同 SKU 双实例共 10 行', async () => {
    const user = userEvent.setup()
    const blank = { ...payment(), existingAllocations: [] }
    const fiveEmployees = [...employees, 'EMP-5']
    const candidates = fiveEmployees.map((employeeId) => ({
      employeeId, name: employeeId, storeId: 'store-1', positionName: '养生师',
      skills: ['养生师'], isResigned: false as const, isOnBusinessTrip: false,
      assignmentScope: 'local' as const,
    }))
    render(<PaymentAllocationDetailPageClient
      payment={blank} storeId="store-1" customerName="测试顾客"
      employees={candidates} skillTags={[{ id: 'tag-1', name: '养生师', sortOrder: 1, createdAt: '', updatedAt: '' }]}
      canSave
    />)

    for (const [index, employeeId] of fiveEmployees.entries()) {
      await user.click(screen.getByRole('button', { name: '+ 添加分配' }))
      const selects = screen.getAllByRole('combobox')
      await user.selectOptions(selects[index * 3], '养生师')
      await user.selectOptions(selects[index * 3 + 1], employeeId)
      await user.selectOptions(selects[index * 3 + 2], '20')
    }
    expect(screen.getAllByText('员工')).toHaveLength(5)
    await user.click(screen.getByRole('button', { name: '保存分配' }))
    await waitFor(() => expect(savePaymentAllocations).toHaveBeenCalledOnce())
    expect(savePaymentAllocations).toHaveBeenCalledWith(7, fiveEmployees.flatMap((employeeId) => items.map((item) => ({
      saleItemId: item.saleItemId, employeeId, roleType: '养生师', allocationRatio: '0.200',
    }))))
  })

  it('两个同 SKU 实例的 4 人历史分配完整回显，保存展开为 8 行', async () => {
    const user = userEvent.setup()
    render(<PaymentAllocationDetailPageClient payment={payment()} storeId="store-1" customerName="测试顾客" employees={[]} canSave />)

    expect(screen.getAllByText('员工')).toHaveLength(4)
    expect(screen.getByText('已合并 2 条明细')).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: '保存分配' }))

    await waitFor(() => expect(savePaymentAllocations).toHaveBeenCalledOnce())
    expect(savePaymentAllocations).toHaveBeenCalledWith(7, employees.flatMap((employeeId) => items.map((item) => ({
      saleItemId: item.saleItemId,
      employeeId,
      roleType: '养生师',
      allocationRatio: '0.250',
    }))))
    expect(toast.error).not.toHaveBeenCalled()
  })

  it('4 人比例总和超 100% 仍在页面被拦截', async () => {
    const user = userEvent.setup()
    render(<PaymentAllocationDetailPageClient payment={payment('0.300')} storeId="store-1" customerName="测试顾客" employees={[]} canSave />)
    await user.click(screen.getByRole('button', { name: '保存分配' }))

    expect(savePaymentAllocations).not.toHaveBeenCalled()
    expect(toast.error).toHaveBeenCalledWith('疗程卡 的养生师分配比例合计超过 100%')
  })
})
