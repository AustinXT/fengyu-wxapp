/**
 * 两个员工页面**真的采用**了 `EmployeeOwnershipFields` 回传的补丁（#259）。
 *
 * ## 为什么组件级交互测试还不够
 *
 * `components/employee-ownership-fields.test.tsx` 用自己的 `Host` 验证组件「发出了正确的
 * patch」，但证明不了页面「正确采用了 patch」—— codex 谱系第 8 轮给的绕过：页面写成
 * `setForm(prev => ({ ...prev, ...patch, orgNodeId: prev.orgNodeId }))`，组件测试仍用自己的
 * Host 所以全绿、结构守护也仍能匹配 `<EmployeeOwnershipFields` 和 `...patch`，
 * 而真实页面继续提交「新门店 + 旧组织」，被服务端归属自洽校验拒掉。
 *
 * 这里渲染**真实页面**、真的改门店下拉、断言提交给 `createEmployee` / `updateEmployee` 的
 * payload 里另一个字段也跟着变了 —— 这是用户实际走的那条路，没有"再找个绕过"的空间。
 *
 * 这是同一主题的第四层，也是最后一层：口径（纯函数）→ 接线（组件交互）→ 采用（本文件）
 * → 页面里有没有这个组件（`lib/org-ancestry-form-wiring.test.ts` 的结构守护）。
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import type { Employee, OrgNode, Store } from '@/lib/types'

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn(), back: vi.fn() }),
}))
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() } }))
vi.mock('@/lib/hooks/use-unsaved-changes', () => ({ useUnsavedChanges: () => {} }))
vi.mock('@/components/ui/image-upload', () => ({
  ImageUpload: () => null,
  toHttpUrl: (v: string) => v,
}))
vi.mock('@/components/return-context', () => ({
  useReturnContext: () => ({ goToReturn: vi.fn() }),
}))
vi.mock('@/actions/employees', () => ({
  createEmployee: vi.fn().mockResolvedValue({ success: true, message: '员工创建成功' }),
  updateEmployee: vi.fn().mockResolvedValue({ success: true, message: '员工信息已更新' }),
  deleteEmployee: vi.fn(),
}))
vi.mock('@/actions/permissions', () => ({ assignRole: vi.fn(), revokeRole: vi.fn() }))
vi.mock('@/actions/auth', () => ({ resetToDefaultPassword: vi.fn() }))

import EmployeeCreatePage from './create/_components/employee-create-page'
import EmployeeDetailPage from './[id]/_components/employee-detail-page'
import { createEmployee, updateEmployee } from '@/actions/employees'

/**
 * 总部 hq → 市场 m1 → 门店 org-s1 / org-s2
 * 两个门店同属一个市场 —— 这样门店下拉（按市场过滤）里两个都在，才测得到「同市场内调店」
 * 这个正是生产两条脏数据的场景。
 */
const ORG_NODES = [
  { id: 'hq', name: '总部', type: '总部', parentId: null, sortOrder: 0, isActive: true },
  { id: 'm1', name: '市场一', type: '市场', parentId: 'hq', sortOrder: 0, isActive: true },
  { id: 'org-s1', name: 'A店', type: '门店', parentId: 'm1', sortOrder: 0, isActive: true },
  { id: 'org-s2', name: 'B店', type: '门店', parentId: 'm1', sortOrder: 1, isActive: true },
] as unknown as OrgNode[]

const STORES = [
  { storeId: 'S001', storeName: 'A店', orgNodeId: 'org-s1' },
  { storeId: 'S002', storeName: 'B店', orgNodeId: 'org-s2' },
] as unknown as Store[]

const EMPLOYEE = {
  employeeId: 'FY-001', name: '张三', gender: '男', phone: '13800000000',
  idCard: '110101199003078888', storeId: 'S001', storeName: 'A店', orgNodeId: 'org-s1',
  positionName: '美容师', avatarUrl: null, birthday: null, hiredAt: '2026-01-01',
  leaveStart: null, leaveEnd: null, isOnBusinessTrip: false, skills: [],
  socialInsurance: true, isResigned: false, resignedAt: null, resignationReason: null,
  updatedAt: '2026-01-01T00:00:00.000Z', createdAt: '2026-01-01T00:00:00.000Z',
} as unknown as Employee

beforeEach(() => {
  vi.clearAllMocks()
  ;(createEmployee as any).mockResolvedValue({ success: true, message: '员工创建成功' })
  ;(updateEmployee as any).mockResolvedValue({ success: true, message: '员工信息已更新' })
})

function pickStore(storeId: string) {
  fireEvent.change(screen.getByLabelText('所属门店'), { target: { value: storeId } })
}

/** 展开 OrgTreeSelect 的树并点选某个节点 */
function pickOrgNode(name: string) {
  fireEvent.click(screen.getByText('请选择所属组织'))
  for (let i = 0; i < 2; i++) {
    for (const arrow of screen.queryAllByText('▸')) fireEvent.click(arrow)
  }
  fireEvent.click(screen.getByRole('button', { name }))
}

describe('新增员工页 — 归属联动真的落进提交 payload', () => {
  it('改门店 → 提交的 orgNodeId 跟着变成新门店的节点', async () => {
    render(<EmployeeCreatePage stores={STORES} orgNodes={ORG_NODES} skillTags={[]} />)

    /**
     * 先选**组织** A 店节点 —— 门店会自动联动到 A 店。
     * （反过来先选门店不行：组织为空时 `applyStoreSelection` 按设计只改门店，
     * 因为「无组织归属」本身是合法状态，不该替用户凭空填一个。）
     */
    pickOrgNode('A店')
    fireEvent.change(screen.getByPlaceholderText('请输入姓名'), { target: { value: '张三' } })
    fireEvent.change(screen.getByPlaceholderText('请输入手机号'), { target: { value: '13800000000' } })
    fireEvent.change(screen.getByPlaceholderText('请输入身份证号'), {
      target: { value: '110101199003078888' },
    })
    // 再同市场调到 B 店 —— 组织必须跟着走，否则服务端判「所选组织节点属于另一个门店」
    pickStore('S002')

    fireEvent.click(screen.getByRole('button', { name: '创建员工' }))

    await waitFor(() => expect(createEmployee).toHaveBeenCalled())
    expect((createEmployee as any).mock.calls[0][0]).toMatchObject({
      storeId: 'S002', orgNodeId: 'org-s2',
    })
  })
})

describe('员工详情页 — 归属联动真的落进提交 payload', () => {
  function renderDetail() {
    render(
      <EmployeeDetailPage
        employee={EMPLOYEE}
        roles={[]}
        roleDefinitions={[]}
        stores={STORES}
        orgNodes={ORG_NODES}
        skillTags={[]}
        canUpdate
      />,
    )
    fireEvent.click(screen.getByRole('button', { name: '编辑' }))
  }

  it('同市场内改门店 → 提交的 orgNodeId 跟着变（生产两条脏数据的场景）', async () => {
    renderDetail()

    pickStore('S002')
    fireEvent.click(screen.getByRole('button', { name: '保存' }))

    await waitFor(() => expect(updateEmployee).toHaveBeenCalled())
    expect((updateEmployee as any).mock.calls[0][1]).toMatchObject({
      storeId: 'S002', orgNodeId: 'org-s2',
    })
  })

  it('非编辑态展示只读文本，不渲染可编辑下拉', () => {
    render(
      <EmployeeDetailPage
        employee={EMPLOYEE}
        roles={[]}
        roleDefinitions={[]}
        stores={STORES}
        orgNodes={ORG_NODES}
        skillTags={[]}
        canUpdate
      />,
    )

    expect(screen.queryByLabelText('所属门店')).toBeNull()
  })
})
