
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

/**
 * 过滤掉已停用（isValid=false）的技能标签值。
 *
 * 防御「幽灵筛选」：URL `?skill=TAG` 残留已被 admin 停用的标签时，后端 `employees.ts`
 * 仍按 `staff_wechat_users.skills && ARRAY[TAG]` 过滤（列表被静默收窄），但前端 MultiSelect
 * 的 `options` 只含 `isValid` 标签 → `count`/`displayText`/`✕`/`清空` 全失效态不渲染，
 * 列表被过滤却 UI 不可见、组件内不可清除。
 *
 * 在 `page.tsx`（后端查询前）与 `employees-page.tsx`（前端 selectedSkills 派生）双端调用，
 * 让失效标签在整条链路变 no-op：后端不再按失效标签过滤、前端 value ⊆ options 恒成立。
 *
 * @param raw URL 解析出的原始 skills（可能含失效标签）
 * @param validNames 当前 isValid 的标签名集合（`new Set(skillTags.filter(t => t.isValid).map(t => t.name))`）
 * @returns 清洗后的有效标签；空输入或清洗后为空 → undefined（与 parseEmployeeFilters 的 skills 契约一致）
 */
export function filterValidSkillValues(
  raw: string[] | undefined,
  validNames: Set<string>,
): string[] | undefined {
  if (!raw?.length) return undefined
  const filtered = raw.filter((s) => validNames.has(s))
  return filtered.length ? filtered : undefined
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
