import type { Employee } from '@/lib/types'
import { isEmployeeInStoreAssignmentScope } from '@/lib/employee-assignment'

const ASSIGNABLE_SKILLS = new Set(['美容师', '养生师'])

/**
 * 创建销售单/服务单时“指定美容师”的统一候选规则：
 * 在职、有绑定门店、具备美容师或养生师技能，且属于开单门店或正在出差支援。
 */
export function isOrderServiceStaffCandidate(
  employee: Pick<Employee, 'isResigned' | 'storeId' | 'skills' | 'isOnBusinessTrip' | 'marketName'>,
  targetStoreId: string,
  targetMarketName?: string,
): boolean {
  return Boolean(
    isEmployeeInStoreAssignmentScope(employee, targetStoreId, targetMarketName)
      && employee.skills?.some((skill) => ASSIGNABLE_SKILLS.has(skill)),
  )
}

/**
 * 返回指定门店可选的美容师，并保证本门店员工排在外店出差支援员工之前。
 * 同一分组内按姓名排序，避免上游合并顺序影响 picker 展示。
 */
export function getOrderServiceStaffCandidates(
  employees: Employee[],
  targetStoreId: string,
  targetMarketName?: string,
): Employee[] {
  return employees
    .filter((employee) => isOrderServiceStaffCandidate(employee, targetStoreId, targetMarketName))
    .sort((a, b) => {
      const localStoreOrder = Number(b.storeId === targetStoreId) - Number(a.storeId === targetStoreId)
      if (localStoreOrder !== 0) return localStoreOrder
      return (a.name ?? '').localeCompare(b.name ?? '')
    })
}

/** 管理后台开单/服务单 picker 的统一显示文案。 */
export function formatOrderServiceStaffOption(
  employee: Pick<Employee, 'name' | 'positionName' | 'storeId' | 'isOnBusinessTrip'>,
  targetStoreId: string,
): string {
  const supportTag = employee.isOnBusinessTrip && employee.storeId !== targetStoreId
    ? '（外援）'
    : ''
  return `${employee.name ?? ''} (${employee.positionName ?? ''})${supportTag}`
}
