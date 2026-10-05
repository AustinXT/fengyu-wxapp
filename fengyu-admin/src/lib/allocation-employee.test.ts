import { describe, expect, it } from 'vitest'
import type { AllocationEmployeeCandidate, AssignmentScope } from './types'
import { formatAllocationEmployeeOption, deriveAllocationSkillTag, getAllocationEmployeesForSkill } from './allocation-employee'

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

describe('分配角色身份', () => {
  it.each(['店经理', '美容师', '养生师', '品项老师', '推广师'])('%s 缺历史角色时按实际技能恢复', (role) => {
    expect(deriveAllocationSkillTag([role])).toBe(role)
  })
  it.each(['店经理', '美容师', '养生师', '品项老师', '推广师'])('%s 多技能员工同池不重复，支援排后', (role) => {
    const result = getAllocationEmployeesForSkill([
      candidate('支援', 'cross_market_trip', role, { skills: [role, '养生师'] }),
      candidate('本店', 'local', role),
    ], role)
    expect(result.map(e => e.employeeId)).toEqual(['本店', '支援'])
  })
})

it('分配候选显示本店/实际外援来源，未知来源明确提示', () => {
  expect(formatAllocationEmployeeOption(candidate('本店', 'local'))).toBe('本店（本店）')
  expect(formatAllocationEmployeeOption(candidate('老师', 'cross_market_trip', '品项老师', { marketName: '品项公司', departmentName: '品项部' })))
    .toBe('老师（外援·品项公司·品项部）')
  expect(formatAllocationEmployeeOption(candidate('未知', 'cross_market_trip'))).toBe('未知（外援·来源未设置）')
})
