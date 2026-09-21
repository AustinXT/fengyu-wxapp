const {
  getAssignableEmployeeIds,
  isEmployeeAssignableToStore,
  assertEmployeesAssignableToStore,
  DEFAULT_ASSIGNABLE_SKILLS,
  SERVICE_ORDER_ASSIGNABLE_SKILLS,
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
    // 技能白名单走绑定参数 $4，默认两项（开单口径不受服务单放宽影响）
    expect(query.mock.calls[0][0]).toMatch(/u\.skills && \$4::text\[\]/)
    expect(query.mock.calls[0][1]).toEqual([
      ['emp-local', 'emp-trip'], 'store-a', true, DEFAULT_ASSIGNABLE_SKILLS,
    ])
  })

  test('marketSupport 拼入锚定市场 JOIN 并收窄到目标门店所属市场', async () => {
    const query = vi.fn().mockResolvedValue([
      { employee_id: 'emp-local' },
      { employee_id: 'emp-same-market-trip' },
    ])
    const valid = await getAssignableEmployeeIds(
      { query },
      ['emp-local', 'emp-same-market-trip', 'emp-cross-market-trip'],
      'store-a',
      {
        requireServiceSkills: true,
        skills: SERVICE_ORDER_ASSIGNABLE_SKILLS,
        assignmentScope: 'marketSupport',
      },
    )

    expect([...valid]).toEqual(['emp-local', 'emp-same-market-trip'])
    const sqlText = query.mock.calls[0][0]
    expect(sqlText).toMatch(/employee_market\.type = '市场'/)
    expect(sqlText).toMatch(/target_market\.id = target_store_node\.parent_id/)
    expect(sqlText).toMatch(/employee_market\.id IS NOT NULL AND employee_market\.id = target_market\.id/)
    expect(query.mock.calls[0][1][3]).toEqual(['店经理', '美容师', '养生师', '品项老师'])
  })

  test('marketSupport 不传 skills 时默认四项白名单（防静默退回两项）', async () => {
    const query = vi.fn().mockResolvedValue([])
    await getAssignableEmployeeIds({ query }, ['emp-x'], 'store-a', {
      requireServiceSkills: true,
      assignmentScope: 'marketSupport',
    })

    expect(query.mock.calls[0][1][3]).toEqual(SERVICE_ORDER_ASSIGNABLE_SKILLS)
  })

  test('localOnly 不传 skills 时仍是两项白名单（开单口径不被污染）', async () => {
    const query = vi.fn().mockResolvedValue([])
    await getAssignableEmployeeIds({ query }, ['emp-x'], 'store-a', { requireServiceSkills: true })

    expect(query.mock.calls[0][1][3]).toEqual(DEFAULT_ASSIGNABLE_SKILLS)
  })

  test('marketSupport 的目标门店 JOIN 全程 LEFT（门店未挂组织节点时本店员工仍可选）', async () => {
    const query = vi.fn().mockResolvedValue([])
    await getAssignableEmployeeIds({ query }, ['emp-x'], 'store-a', {
      assignmentScope: 'marketSupport',
    })

    const sqlText = query.mock.calls[0][0]
    expect(sqlText).toMatch(/LEFT JOIN stores target_store/)
    expect(sqlText).not.toMatch(/\n\s+JOIN stores target_store/)
  })

  test('marketSupport 拒绝跨市场出差员工并给出对应文案', async () => {
    const query = vi.fn().mockResolvedValue([{ employee_id: 'emp-local' }])

    await expect(assertEmployeesAssignableToStore(
      { query },
      ['emp-local', 'emp-cross-market-trip'],
      'store-a',
      { requireServiceSkills: true, assignmentScope: 'marketSupport' },
    )).rejects.toThrow(/INVALID_PARAMS.*本门店所属市场内的出差支援人员.*服务技能标签/)
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
