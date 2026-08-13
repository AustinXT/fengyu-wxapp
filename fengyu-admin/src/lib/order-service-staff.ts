import type { Employee } from '@/lib/types'

const ASSIGNABLE_SKILLS = new Set(['美容师', '养生师'])

/**
 * 创建销售单/服务单时“指定美容师”的统一候选规则：
 * 在职、有绑定门店、具备美容师或养生师技能，且属于开单门店或正在出差支援。
 */
export function isOrderServiceStaffCandidate(
  employee: Pick<Employee, 'isResigned' | 'storeId' | 'skills' | 'isOnBusinessTrip'>,
  targetStoreId: string,
): boolean {
  return Boolean(
    targetStoreId
      && !employee.isResigned
      && employee.storeId
      && (employee.storeId === targetStoreId || employee.isOnBusinessTrip)
      && employee.skills?.some((skill) => ASSIGNABLE_SKILLS.has(skill)),
  )
}
