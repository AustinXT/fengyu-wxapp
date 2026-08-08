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
import type { CardFilters } from '@/actions/cards'
import type { CustomerFilters } from '@/actions/customers'

export function parseOrderFilters(params: Record<string, string | undefined>): OrderFilters {
  return {
    status: params.status,
    type: params.type,
    marketId: params.market,
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
    marketId: params.market,
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
    marketId: params.market,
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
    marketId: params.market,
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

/**
 * 过滤掉字典外（已删除）的技能标签值。
 *
 * 防御「幽灵筛选」：URL `?skill=TAG` 残留已被删除的标签名时，后端 `employees.ts`
 * 仍按 `staff_wechat_users.skills && ARRAY[TAG]` 过滤（列表被静默收窄），但前端 MultiSelect
 * 的 `options` 不含该名 → `count`/`displayText`/`✕`/`清空` 全失效态不渲染，
 * 列表被过滤却 UI 不可见、组件内不可清除。
 *
 * 在 `page.tsx`（后端查询前）与 `employees-page.tsx`（前端 selectedSkills 派生）双端调用，
 * 让失效标签在整条链路变 no-op：后端不再按失效标签过滤、前端 value ⊆ options 恒成立。
 *
 * @param raw URL 解析出的原始 skills（可能含字典外标签名）
 * @param validNames 当前字典内全部标签名集合（`new Set(skillTags.map(t => t.name))`）
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

/**
 * 疗程卡管理页筛选解析（列表分页与导出共用，防漂移）。
 * type/status 仅接受合法枚举值，其余视为未选（与 cards/page.tsx 原手工解析口径一致）。
 */
export function parseCardFilters(params: Record<string, string | undefined>): CardFilters {
  const type = params.type as CardFilters['type'] | undefined
  const status = params.status as CardFilters['status'] | undefined
  const productKind = params.productKind || undefined
  return {
    marketId: params.market,
    storeId: params.store,
    type: type === '疗程卡' || type === '单次卡' || type === 'all' ? type : undefined,
    status: status === 'active' || status === 'exhausted' || status === 'expired' ? status : undefined,
    productKind,
    // 二级品项必须从属于一级品项，避免手工 URL 留下无法在 UI 中清除的幽灵条件。
    categoryId: productKind ? params.category || undefined : undefined,
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
