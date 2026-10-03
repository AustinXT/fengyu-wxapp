import { vi, it, expect } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
const mocks = vi.hoisted(() => ({ read: vi.fn(), write: vi.fn() }))
vi.mock('@/actions/role-migrations', () => ({ getEmployeeRoleMigration: mocks.read, reviewEmployeeRoleMigration: mocks.write }))
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }))
import EmployeeRoleMigration from './employee-role-migration'
it('逐条显示旧→新及已有绑定，人工确认后传完整旧绑定CAS', async () => {
  mocks.read.mockResolvedValue({ resigned: false, roles: [{ id: 1, role: 'manager', role_name: '店长', scope_id: 'old', scope_name: '旧店', scope_type: '门店', target_scope_id: 'new', target_store_name: '新店', target_exists: true, canReview: true }], pending: [{ event_id: '10', binding_id: 1 }] })
  mocks.write.mockResolvedValue({ success: true })
  window.confirm = vi.fn(() => true)
  render(<EmployeeRoleMigration initialEmployeeId="E" canAssign canRevoke />)
  expect(await screen.findByText(/已有同角色：保留现有绑定，不新增/)).toBeTruthy()
  fireEvent.click(screen.getByLabelText('选择店长 旧店'))
  fireEvent.click(screen.getByText('预览并确认迁移'))
  await waitFor(() => expect(mocks.write).toHaveBeenCalledWith({ employeeId: 'E', targetScopeId: 'new', eventId: '10', decision: 'migrate', bindings: [{ id: 1, role: 'manager', scopeId: 'old' }] }))
  expect(window.confirm).toHaveBeenCalledWith(expect.stringContaining('旧店 → 新店'))
})
