
import type { OrderFilters } from '@/actions/orders'
import type { ServiceOrderFilters } from '@/actions/services'
import type { EmployeeFilters } from '@/actions/employees'
import type { PointTransactionFilters } from '@/actions/points'

export function parseOrderFilters(params: Record<string, string | undefined>): OrderFilters {
  return {
    status: params.status,
    type: params.type,
    storeId: params.store,
    dateFrom: params.from,
    dateTo: params.to,
    search: params.q,
    paymentMethod: params.payment,
    hasPrepaidDeduction: params.hasPrepaid === '1',
    allocationStatus: params.allocationStatus,
  }
}

export function parseServiceOrderFilters(params: Record<string, string | undefined>): ServiceOrderFilters {
  return {
    status: params.status,
    storeId: params.store,
    dateFrom: params.from,
    dateTo: params.to,
    search: params.q,
  }
}


export function parseAllocationOrderFilters(params: Record<string, string | undefined>): OrderFilters {
  return {
    status: '已支付',
    storeId: params.store,
    dateFrom: params.from,
    dateTo: params.to,
    search: params.q,
    allocationStatus: params.allocStatus,
    
    allocationEligibleOnly: true,
  }
}


export function parseAllocationServiceFilters(params: Record<string, string | undefined>): ServiceOrderFilters {
  return {
    status: '已完成',
    storeId: params.store,
    dateFrom: params.from,
    dateTo: params.to,
    search: params.q,
    commissionStatus: params.allocStatus,
  }
}

export function parseEmployeeFilters(params: Record<string, string | undefined>): EmployeeFilters {
  return {
    marketId: params.market || undefined,
    storeId: params.store,
    status: (params.status as 'active' | 'resigned') || undefined,
    search: params.q,
  }
}

export function parsePointFilters(params: Record<string, string | undefined>): PointTransactionFilters {
  return {
    marketId: params.market,
    storeId: params.store,
    type: params.type,
    search: params.q,
    startDate: params.start,
    endDate: params.end,
  }
}
