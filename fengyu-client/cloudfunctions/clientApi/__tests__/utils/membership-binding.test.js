const path = require('node:path')
const fs = require('node:fs')
const root = path.resolve(__dirname, '../../../../..')

for (const endpoint of ['fengyu-client/cloudfunctions/clientApi', 'fengyu-staff/cloudfunctions/staffApi']) {
  const { assertMembershipBinding } = require(path.join(root, endpoint, 'utils/membership-binding'))
  describe(`${endpoint} 首次入会员工归属`, () => {
    test.each([
      { customer_type: '流量客', became_member_at: null, has_binding: true },
      { customer_type: '会员客', became_member_at: null, has_binding: false },
      { customer_type: '小美客', became_member_at: '2026-08-01', has_binding: false },
    ])('已分配/存量会员不阻断 %#', async (customer) => {
      const query = vi.fn().mockResolvedValue({ rows: [customer] })
      await assertMembershipBinding({ query }, 'customer-1')
      expect(query.mock.calls[0][1]).toEqual(['customer-1'])
      expect(query.mock.calls[0][0]).toContain('FOR NO KEY UPDATE OF c')
    })
    test('新客缺真实员工归属拒绝，姓名或开单人不能替代', async () => {
      const query = vi.fn().mockResolvedValue({ rows: [{ customer_type: '小美客', became_member_at: null, has_binding: false }] })
      await expect(assertMembershipBinding({ query }, 'customer-1')).rejects.toThrow('MEMBERSHIP_BINDING_REQUIRED')
      expect(query.mock.calls[0][0]).toContain('e.employee_id = c.bound_employee_id')
    })
    test('顾客已删除拒绝', async () => {
      await expect(assertMembershipBinding({ query: vi.fn().mockResolvedValue({ rows: [] }) }, 'missing')).rejects.toThrow('NOT_FOUND')
    })
  })
}

test('两端绑定守护独立副本一致，成功回调不接入门禁', () => {
  expect(fs.readFileSync(path.join(root, 'fengyu-client/cloudfunctions/clientApi/utils/membership-binding.js'), 'utf8'))
    .toBe(fs.readFileSync(path.join(root, 'fengyu-staff/cloudfunctions/staffApi/utils/membership-binding.js'), 'utf8'))
  expect(fs.readFileSync(path.join(root, 'fengyu-client/cloudfunctions/payNotify/index.js'), 'utf8')).not.toContain('assertMembershipBinding')
})
