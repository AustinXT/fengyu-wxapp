import { describe, expect, it } from 'vitest'
import type { AllocationEmployeeCandidate, AssignmentScope } from './types'
import { getAllocationEmployeesForSkill } from './allocation-employee'

function candidate(
  employeeId: string,
  assignmentScope: AssignmentScope,
  skill = '品项老师',
  overrides: Partial<AllocationEmployeeCandidate> = {},
): AllocationEmployeeCandidate {
  return {
    employeeId,
    name: employeeId,
    storeId: null,
    positionName: null,
    skills: [skill],
    isResigned: false,
    isOnBusinessTrip: assignmentScope !== 'local',
    assignmentScope,
    ...overrides,
  }
}

describe('getAllocationEmployeesForSkill', () => {
  it('所有技能统一按本店、本市场出差、跨市场出差排序', () => {
    const result = getAllocationEmployeesForSkill([
      candidate('跨市场', 'cross_market_trip', '推广部拓', { marketName: '市场B' }),
      candidate('本市场', 'same_market_trip', '推广部拓', { marketName: '市场A' }),
      candidate('本店', 'local', '推广部拓'),
      candidate('其他技能', 'local', '养生师'),
    ], '推广部拓')

    expect(result.map((employee) => employee.employeeId)).toEqual(['本店', '本市场', '跨市场'])
  })

  it('无市场归属的出差员工保留在跨市场组', () => {
    const result = getAllocationEmployeesForSkill([
      candidate('总部品项老师', 'cross_market_trip'),
    ], '品项老师')

    expect(result).toHaveLength(1)
    expect(result[0].assignmentScope).toBe('cross_market_trip')
  })
})
