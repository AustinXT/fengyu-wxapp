import type { Employee } from '@/lib/types'

const ASSIGNABLE_SKILLS = new Set(['美容师', '养生师'])

/**
 * 创建销售单/服务单时“指定美容师”的统一候选规则：
 * 在职、属于开单门店，并具备美容师或养生师技能。出差支援不作用于本场景。
 */
export function isOrderServiceStaffCandidate(
  employee: Pick<Employee, 'isResigned' | 'storeId' | 'skills' | 'isOnBusinessTrip' | 'marketName'>,
  targetStoreId: string,
  _targetMarketName?: string,
): boolean {
  return Boolean(
    !employee.isResigned
      && employee.storeId === targetStoreId
      && employee.skills?.some((skill) => ASSIGNABLE_SKILLS.has(skill)),
  )
}

/**
 * 返回指定门店可选的美容师，并按姓名稳定排序。
 */
export function getOrderServiceStaffCandidates(
  employees: Employee[],
  targetStoreId: string,
  targetMarketName?: string,
): Employee[] {
  return employees
    .filter((employee) => isOrderServiceStaffCandidate(employee, targetStoreId, targetMarketName))
    .sort((a, b) => {
      return (a.name ?? '').localeCompare(b.name ?? '')
    })
}

/** 管理后台开单/服务单 picker 的统一显示文案。 */
export function formatOrderServiceStaffOption(
  employee: Pick<Employee, 'name' | 'positionName'>,
  _targetStoreId: string,
): string {
  return `${employee.name ?? ''} (${employee.positionName ?? ''})`
}
