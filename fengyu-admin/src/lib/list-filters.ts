/**
 * URL searchParams → 各列表 Filters 的单一映射真源（纯函数，无副作用）。
 *
 * 抽到这里而非各 actions 文件，是因为 actions 文件带 `'use server'`，
 * 只能导出 async 函数；而 page.tsx（Server Component）与导出 action 都需复用
 * 同一份映射以避免漂移，故放在普通模块。
 */
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

/**
 * 营业额分配「销售提成」页筛选解析。
 * 与 orders 列表不同：状态锁定「已支付」，分配状态走 allocStatus URL 参数
 * （与 page.tsx 的 getOrdersPaginated 入参口径一致，避免列表/导出漂移）。
 */
export function parseAllocationOrderFilters(params: Record<string, string | undefined>): OrderFilters {
  return {
    status: '已支付',
    storeId: params.store,
    dateFrom: params.from,
    dateTo: params.to,
    search: params.q,
    allocationStatus: params.allocStatus,
    // 只保留参与营业额分配的订单类型（排除寄存单/充值单/内部单）
    allocationEligibleOnly: true,
  }
}

/**
 * 营业额分配「服务提成」页筛选解析。
 * 状态锁定「已完成」，提成状态走 allocStatus URL 参数
 * （与 page.tsx 的 getServiceOrdersPaginated 入参口径一致）。
 */
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
