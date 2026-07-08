
import type { OrderFilters } from '@/actions/orders'
import type { ServiceOrderFilters } from '@/actions/services'
import type { EmployeeFilters } from '@/actions/employees'
import type { PointTransactionFilters } from '@/actions/points'
import type { CardFilters } from '@/actions/cards'
import type { CustomerFilters } from '@/actions/customers'

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
  // skills 多选 URL 编码：逗号分隔（与 useUrlFilters 单值接口兼容，避免动 URL 多 key 协议）
  const skillRaw = params.skill
  const skills = skillRaw
    ? skillRaw.split(',').map(s => s.trim()).filter(Boolean)
    : undefined
  return {
    marketId: params.market || undefined,
    storeId: params.store,
    status: (params.status as 'active' | 'resigned') || undefined,
    search: params.q,
    skills: skills?.length ? skills : undefined,
    page: params.page ? Number(params.page) : undefined,
    pageSize: params.size ? Number(params.size) : undefined,
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

/**
 * 疗程卡管理页筛选解析（列表分页与导出共用，防漂移）。
 * type/status 仅接受合法枚举值，其余视为未选（与 cards/page.tsx 原手工解析口径一致）。
 */
export function parseCardFilters(params: Record<string, string | undefined>): CardFilters {
  const type = params.type as CardFilters['type'] | undefined
  const status = params.status as CardFilters['status'] | undefined
  return {
    marketId: params.market,
    storeId: params.store,
    type: type === '疗程卡' || type === '单次卡' || type === 'all' ? type : undefined,
    status: status === 'active' || status === 'exhausted' || status === 'expired' ? status : undefined,
    search: params.q,
    page: params.page ? Number(params.page) : undefined,
    pageSize: params.size ? Number(params.size) : undefined,
  }
}

/**
 * 顾客管理页筛选解析（列表分页与导出共用，防漂移）。
 * 8 维度筛选 + 姓名/手机号搜索；page/size 转 number 后透传。
 */
export function parseCustomerFilters(params: Record<string, string | undefined>): CustomerFilters {
  return {
    marketId: params.market,
    storeId: params.store,
    memberLevel: params.level,
    customerSource: params.source,
    customerType: params.type,
    spendingTier: params.tier,
    monthlyActivity: params.activity,
    customerStatus: params.status,
    search: params.q,
    page: params.page ? Number(params.page) : undefined,
    pageSize: params.size ? Number(params.size) : undefined,
  }
}
