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
    expect(query.params).toEqual(['emp-local', 'store-a', true])
    expect(query.sql).toContain('AND u.store_id = $2')
    expect(query.sql).not.toContain('is_on_business_trip = true')
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
