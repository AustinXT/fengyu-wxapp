import { beforeEach, describe, expect, it, vi } from 'vitest'
import { PgDialect } from 'drizzle-orm/pg-core'

const mocks = vi.hoisted(() => ({ execute: vi.fn() }))

vi.mock('@/db', () => ({ db: { execute: mocks.execute } }))

import { getInvalidEmployeeAssignmentId } from './employee-assignment-server'

describe('getInvalidEmployeeAssignmentId', () => {
  beforeEach(() => mocks.execute.mockReset())

  it('默认仅本店员工有效', async () => {
    mocks.execute.mockResolvedValue([
      { employee_id: 'emp-local' },
    ])

    await expect(getInvalidEmployeeAssignmentId(
      ['emp-local'],
      'store-a',
      { requireServiceSkills: true },
    )).resolves.toBeNull()
    expect(mocks.execute).toHaveBeenCalledOnce()

    const query = new PgDialect().sqlToQuery(mocks.execute.mock.calls[0][0])
    expect(query.sql).toContain('WHERE u.employee_id IN ($1)')
    // 技能白名单走绑定参数（sql.param 整体传数组），默认两项
    expect(query.params).toEqual(['emp-local', 'store-a', true, ['美容师', '养生师']])
    expect(query.sql).toContain('AND u.store_id = $2')
    expect(query.sql).toContain('u.skills && $4::text[]')
    expect(query.sql).not.toContain('is_on_business_trip = true')
  })

  it('marketSupport 放行同市场出差员工、挡住跨市场与锚不到市场的人', async () => {
    mocks.execute.mockResolvedValue([
      { employee_id: 'emp-local' },
      { employee_id: 'emp-same-market-trip' },
    ])

    await expect(getInvalidEmployeeAssignmentId(
      ['emp-local', 'emp-same-market-trip'],
      'store-a',
      {
        requireServiceSkills: true,
        assignmentScope: 'marketSupport',
        skills: ['店经理', '美容师', '养生师', '品项老师'],
      },
    )).resolves.toBeNull()

    const query = new PgDialect().sqlToQuery(mocks.execute.mock.calls[0][0])
    // 锚定市场 JOIN 已拼入，且用「员工锚定市场 = 目标门店市场」收窄
    expect(query.sql).toContain('employee_market.type')
    expect(query.sql).toContain('target_market.id = target_store_node.parent_id')
    expect(query.sql).toContain('employee_market.id IS NOT NULL AND employee_market.id = target_market.id')
    // 四项技能白名单整体作为一个绑定参数
    expect(query.params).toContainEqual(['店经理', '美容师', '养生师', '品项老师'])
  })

  it('marketSupport 下未命中候选时返回第一个非法 id', async () => {
    mocks.execute.mockResolvedValue([{ employee_id: 'emp-local' }])

    await expect(getInvalidEmployeeAssignmentId(
      ['emp-local', 'emp-cross-market-trip'],
      'store-a',
      { requireServiceSkills: true, assignmentScope: 'marketSupport' },
    )).resolves.toBe('emp-cross-market-trip')
  })

  it('marketSupport 不传 skills 时默认四项白名单，localOnly 仍是两项', async () => {
    mocks.execute.mockResolvedValue([])

    await getInvalidEmployeeAssignmentId(['emp-x'], 'store-a', {
      requireServiceSkills: true,
      assignmentScope: 'marketSupport',
    })
    expect(new PgDialect().sqlToQuery(mocks.execute.mock.calls[0][0]).params)
      .toContainEqual(['店经理', '美容师', '养生师', '品项老师'])

    mocks.execute.mockClear()
    await getInvalidEmployeeAssignmentId(['emp-x'], 'store-a', { requireServiceSkills: true })
    expect(new PgDialect().sqlToQuery(mocks.execute.mock.calls[0][0]).params)
      .toContainEqual(['美容师', '养生师'])
  })

  it('marketSupport 的目标门店 JOIN 全程 LEFT（门店未挂组织节点时本店员工仍可选）', async () => {
    mocks.execute.mockResolvedValue([])

    await getInvalidEmployeeAssignmentId(['emp-x'], 'store-a', { assignmentScope: 'marketSupport' })

    const { sql: text } = new PgDialect().sqlToQuery(mocks.execute.mock.calls[0][0])
    expect(text).toContain('LEFT JOIN stores target_store')
    expect(text).not.toMatch(/\n\s+JOIN stores target_store/)
  })

  it('allocationSupport 允许任意市场及无门店的出差员工', async () => {
    mocks.execute.mockResolvedValue([
      { employee_id: 'emp-local' },
      { employee_id: 'emp-cross-market-trip' },
      { employee_id: 'emp-storeless-trip' },
    ])

    await expect(getInvalidEmployeeAssignmentId(
      ['emp-local', 'emp-cross-market-trip', 'emp-storeless-trip'],
      'store-a',
      { assignmentScope: 'allocationSupport' },
    )).resolves.toBeNull()

    const query = new PgDialect().sqlToQuery(mocks.execute.mock.calls[0][0])
    expect(query.sql).toContain('u.store_id = $4 OR u.is_on_business_trip = true')
    expect(query.sql).not.toContain('parent_id')
  })
})
