const {
  getAssignableEmployeeIds,
  isEmployeeAssignableToStore,
  assertEmployeesAssignableToStore,
} = require('../../utils/employee-assignment')

describe('employee-assignment 场景隔离', () => {
  test('默认 localOnly 仅允许本店服务员工', async () => {
    const query = vi.fn().mockResolvedValue([{ employee_id: 'emp-local' }])
    const valid = await getAssignableEmployeeIds({ query }, ['emp-local', 'emp-trip'], 'store-a', {
      requireServiceSkills: true,
    })

    expect([...valid]).toEqual(['emp-local'])
    expect(query.mock.calls[0][0]).toMatch(/AND u\.store_id = \$2/)
    expect(query.mock.calls[0][0]).not.toMatch(/u\.is_on_business_trip\s*=\s*true/)
    expect(query.mock.calls[0][1]).toEqual([['emp-local', 'emp-trip'], 'store-a', true])
  })

  test('allocationSupport 允许本店及任意市场或无门店的出差员工', async () => {
    const query = vi.fn().mockResolvedValue([
      { employee_id: 'emp-local' },
      { employee_id: 'emp-same-market-trip' },
      { employee_id: 'emp-cross-market-trip' },
      { employee_id: 'emp-storeless-trip' },
    ])
    const ids = ['emp-local', 'emp-same-market-trip', 'emp-cross-market-trip', 'emp-storeless-trip']
    const valid = await getAssignableEmployeeIds({ query }, ids, 'store-a', {
      assignmentScope: 'allocationSupport',
    })

    expect([...valid]).toEqual(ids)
    expect(query.mock.calls[0][0]).toMatch(/u\.store_id = \$2 OR u\.is_on_business_trip = true/)
    expect(query.mock.calls[0][0]).not.toMatch(/parent_id|employee_market|品项老师/)
  })

  test('外店未出差员工不在分配有效集合并被拒绝', async () => {
    const query = vi.fn().mockResolvedValue([{ employee_id: 'emp-local' }])
    const queryable = { query }

    await expect(isEmployeeAssignableToStore(queryable, 'emp-other', 'store-a', {
      assignmentScope: 'allocationSupport',
    })).resolves.toBe(false)
    await expect(assertEmployeesAssignableToStore(
      queryable,
      ['emp-local', 'emp-other'],
      'store-a',
      { assignmentScope: 'allocationSupport' },
    )).rejects.toThrow(/INVALID_PARAMS.*未开启出差支援/)
  })
})
