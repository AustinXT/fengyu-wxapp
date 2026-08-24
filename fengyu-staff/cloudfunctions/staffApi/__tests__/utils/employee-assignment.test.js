const {
  getAssignableEmployeeIds,
  isEmployeeAssignableToStore,
  assertEmployeesAssignableToStore,
} = require('../../utils/employee-assignment')

describe('employee-assignment 同市场出差资格', () => {
  test('用门店组织节点 parent_id 比较市场，并传递服务技能开关', async () => {
    const query = vi.fn().mockResolvedValue([{ employee_id: 'emp-local' }, { employee_id: 'emp-trip' }])
    const valid = await getAssignableEmployeeIds({ query }, ['emp-local', 'emp-trip'], 'store-a', {
      requireServiceSkills: true,
    })

    expect([...valid]).toEqual(['emp-local', 'emp-trip'])
    expect(query.mock.calls[0][0]).toMatch(/employee_store_node\.parent_id\s*=\s*target_store_node\.parent_id/)
    expect(query.mock.calls[0][0]).toMatch(/u\.is_on_business_trip\s*=\s*true/)
    expect(query.mock.calls[0][1]).toEqual([['emp-local', 'emp-trip'], 'store-a', true])
  })

  test('跨市场或不存在员工不在有效集合并被拒绝', async () => {
    const query = vi.fn().mockResolvedValue([{ employee_id: 'emp-local' }])
    const queryable = { query }

    await expect(isEmployeeAssignableToStore(queryable, 'emp-cross-market', 'store-a')).resolves.toBe(false)
    await expect(assertEmployeesAssignableToStore(
      queryable,
      ['emp-local', 'emp-cross-market'],
      'store-a',
    )).rejects.toThrow(/INVALID_PARAMS.*同市场出差支援范围/)
  })
})

