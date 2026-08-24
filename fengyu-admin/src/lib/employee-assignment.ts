import type { Employee } from '@/lib/types'

export function isEmployeeInStoreAssignmentScope(
  employee: Pick<Employee, 'isResigned' | 'storeId' | 'isOnBusinessTrip' | 'marketName'>,
  targetStoreId: string,
  targetMarketName?: string,
): boolean {
  if (!targetStoreId || employee.isResigned || !employee.storeId) return false
  if (employee.storeId === targetStoreId) return true
  return Boolean(
    employee.isOnBusinessTrip
      && targetMarketName
      && employee.marketName
      && employee.marketName === targetMarketName,
  )
}

