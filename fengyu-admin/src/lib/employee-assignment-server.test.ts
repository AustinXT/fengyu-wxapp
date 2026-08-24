import { beforeEach, describe, expect, it, vi } from 'vitest'
import { PgDialect } from 'drizzle-orm/pg-core'

const mocks = vi.hoisted(() => ({ execute: vi.fn() }))

vi.mock('@/db', () => ({ db: { execute: mocks.execute } }))

import { getInvalidEmployeeAssignmentId } from './employee-assignment-server'

describe('getInvalidEmployeeAssignmentId', () => {
  beforeEach(() => mocks.execute.mockReset())

  it('本店和同市场出差员工均有效', async () => {
    mocks.execute.mockResolvedValue([
      { employee_id: 'emp-local' },
      { employee_id: 'emp-same-market-trip' },
    ])

    await expect(getInvalidEmployeeAssignmentId(
      ['emp-local', 'emp-same-market-trip'],
      'store-a',
      { requireServiceSkills: true },
    )).resolves.toBeNull()
    expect(mocks.execute).toHaveBeenCalledOnce()

    const query = new PgDialect().sqlToQuery(mocks.execute.mock.calls[0][0])
    expect(query.sql).toContain('WHERE u.employee_id IN ($2, $3)')
    expect(query.params).toEqual([
      'store-a',
      'emp-local',
      'emp-same-market-trip',
      'store-a',
      true,
    ])
    expect(query.sql).not.toContain('ANY(($2, $3)::text[])')
  })

  it('查询未返回的跨市场员工判为无效', async () => {
    mocks.execute.mockResolvedValue([{ employee_id: 'emp-local' }])

    await expect(getInvalidEmployeeAssignmentId(
      ['emp-local', 'emp-cross-market'],
      'store-a',
    )).resolves.toBe('emp-cross-market')
  })
})
