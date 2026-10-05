import type { AllocationEmployeeCandidate, AssignmentScope } from '@/lib/types'

const SCOPE_RANK: Record<AssignmentScope, number> = {
  local: 0,
  same_market_trip: 1,
  cross_market_trip: 2,
}

/** 分配候选固定顺序：本店 → 本市场出差 → 跨市场出差；组内按组织位置和姓名稳定排序。 */
export function sortAllocationEmployeeCandidates(
  employees: AllocationEmployeeCandidate[],
): AllocationEmployeeCandidate[] {
  return [...employees].sort((a, b) => {
    const scopeOrder = SCOPE_RANK[a.assignmentScope] - SCOPE_RANK[b.assignmentScope]
    if (scopeOrder !== 0) return scopeOrder
    for (const [left, right] of [
      [a.marketName, b.marketName],
      [a.storeName, b.storeName],
      [a.departmentName, b.departmentName],
      [a.name, b.name],
      [a.employeeId, b.employeeId],
    ]) {
      const order = (left ?? '').localeCompare(right ?? '', 'zh-CN')
      if (order !== 0) return order
    }
    return 0
  })
}

export function getAllocationEmployeesForSkill(
  employees: AllocationEmployeeCandidate[],
  skillTag: string,
): AllocationEmployeeCandidate[] {
  if (!skillTag) return []
  return sortAllocationEmployeeCandidates(
    employees.filter((employee) => employee.skills?.includes(skillTag)),
  )
}

/** 旧记录缺角色时按实际技能推导，保存的 roleType 优先由调用方保留。 */
export function deriveAllocationSkillTag(skills: string[] = []): string {
  if (skills.includes('推广师')) return '推广师'
  if (skills.includes('养生师')) return '养生师'
  if (skills.includes('店经理')) return '店经理'
  if (skills.includes('品项老师')) return '品项老师'
  return '美容师'
}

/** 分配选择器显示实际来源；缺来源时明确提示，不把技术分类显示为市场事实。 */
export function formatAllocationEmployeeOption(employee: AllocationEmployeeCandidate): string {
  const name = employee.name?.trim() || employee.employeeId
  if (!employee.assignmentScope || employee.assignmentScope === 'local') return `${name}（本店）`
  const source = [employee.marketName, employee.storeName, employee.departmentName].filter(Boolean).join('·') || '来源未设置'
  return `${name}（外援·${source}）`
}
