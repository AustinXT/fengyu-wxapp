/**
 * 数据中心板块上下文预备（scope 校验 + 时间解析 + meta 构建）
 *
 * 每个板块 action 第一步调用 prepareBoardContext，统一：
 *   1. validateScope —— UI 选的 scope 必须在账号权限内（越权抛 PermissionError）
 *   2. 时间参数复检（#308，非法报 INVALID_PARAMS 不回落）→ resolveTimeRange 解析本期/上期/去年同期
 *   3. resolveScopeName —— scope 显示名（回显）
 * 返回 meta + comparison 区间 + enabled，板块只管自己的指标查询。
 *
 * 注意：放在 lib/ 而非 actions/，因含纯/DB 辅助函数（actions/ 的 ESLint 规则要求每个 export 都 HOF 包装）。
 */
import { db } from '@/db'
import { orgNodes, stores } from '@db/org'
import { eq, inArray } from 'drizzle-orm'
import { isAdminScope, expandVisibleMarketIds, PermissionError } from '@/lib/permissions'
import type { AuthSession } from '@/lib/types'
import type { BoardMeta, BoardParams, DataCenterScope } from './types'
import { resolveTimeRange } from './time-range'
import { toComparisonRanges, type ComparisonRanges } from './comparison'
import { multiStoreName } from './scope-options'
import { isValidStoresScopeIds, MAX_SCOPE_STORES, toTimeRangeInput } from './params'

/** 账号能选的最高 scope 层级（驱动筛选器禁用「全部」等） */
export function getScopeTopLevel(session: AuthSession): 'all' | 'market' | 'store' {
  if (isAdminScope(session) || session.roles.some((r) => r.scopeType === '总部')) return 'all'
  if (session.roles.some((r) => r.scopeType === '市场')) return 'market'
  return 'store'
}

/**
 * UI 选中的 scope 是否在账号权限内；越权抛 PermissionError（仿 staff validateScope）。
 *
 * ⚠️ 已知限制（issue #133 的 pr-ready 审查记录）：`PermissionError` 的 `digest` 是裸 token
 * `'PERMISSION_DENIED'`（类字段，先于 `rethrowWithDigest` 存在故不被覆盖），下面 4 条具体理由
 * 只活在 `message` 里，而生产构建会把 message 脱敏。于是 4 个看板（SalesBoard/CustomerBoard/
 * EfficiencyBoard/ProductBoard）的内联红字线上一律退化成「无权执行该操作」，用户分不清
 * 该找人授权还是该切 scope。
 *
 * 修法是让 `PermissionError.digest` 带上完整 message。**技术改动面很小**：`error.tsx` 已改走
 * `actionErrorType`，它经 `parseErrorPrefix` 对 `PERMISSION_DENIED: 理由` 照样判出 403，
 * 无需再动渲染链路（issue #133 评审 round 3 纠正了这里原先「要动全局 401/403」的夸大表述）。
 *
 * 真正的工作量在**逐条审文案**：`requirePermission` 抛的是 `无权执行 ${action}`，直接透出等于把
 * 内部动作 ID（`employee:update`）端给用户，比现在的「无权执行该操作」更差。所以要先给每个
 * PermissionError 定一句面向用户的话，才能放开透传 —— 属文案决策，另开 issue。
 */
export async function validateScope(session: AuthSession, scope: DataCenterScope): Promise<void> {
  // 多店形状先于任何角色短路：admin / 总部同样不能带空列表或超长列表进 SQL（#376）
  if (scope.type === 'stores' && !isValidStoresScopeIds(scope.ids)) {
    throw new Error(`INVALID_PARAMS: 多店范围须为 2~${MAX_SCOPE_STORES} 家不重复的门店`)
  }
  if (isAdminScope(session)) return
  if (session.roles.some((r) => r.scopeType === '总部')) return

  if (scope.type === 'authorized') {
    if (session.permissions.scopeStoreIds.length === 0) {
      throw new PermissionError('PERMISSION_DENIED: 当前账号无可查看的授权门店')
    }
    return
  }
  if (scope.type === 'all') {
    throw new PermissionError('PERMISSION_DENIED: 无权查看全部数据')
  }
  if (scope.type === 'market') {
    const visible = await expandVisibleMarketIds(session) // null=总部（上面已 return）
    if (visible === null) return
    if (!visible.includes(scope.id)) {
      throw new PermissionError('PERMISSION_DENIED: 越权访问其他市场数据')
    }
    return
  }
  // store / stores（#376：所选门店逐个须在授权门店内，任一越权整单拒绝）
  const ids = scope.type === 'stores' ? scope.ids : [scope.id]
  if (!ids.every((id) => session.permissions.scopeStoreIds.includes(id))) {
    throw new PermissionError('PERMISSION_DENIED: 越权访问其他门店数据')
  }
}

/** scope 显示名（全部 / 市场名 / 门店名） */
export async function resolveScopeName(scope: DataCenterScope): Promise<string> {
  if (scope.type === 'all') return '全部'
  if (scope.type === 'authorized') return '全部授权门店'
  if (scope.type === 'market') {
    const [row] = await db
      .select({ name: orgNodes.name })
      .from(orgNodes)
      .where(eq(orgNodes.id, scope.id))
      .limit(1)
    return row?.name ?? '未知市场'
  }
  if (scope.type === 'stores') {
    const rows = await db
      .select({ id: stores.storeId, name: stores.storeName })
      .from(stores)
      .where(inArray(stores.storeId, scope.ids))
      .limit(scope.ids.length)
    const names = new Map(rows.map((r) => [r.id, r.name]))
    return multiStoreName(scope.ids.map((id) => names.get(id) ?? '未知门店'))
  }
  const [row] = await db
    .select({ name: stores.storeName })
    .from(stores)
    .where(eq(stores.storeId, scope.id))
    .limit(1)
  return row?.name ?? '未知门店'
}

/** meta 回显用的 scopeId：市场 / 单店为其 id，多店为逗号串（与 URL 同编码），all / authorized 为 null */
function scopeIdOf(scope: DataCenterScope): string | null {
  if (scope.type === 'market' || scope.type === 'store') return scope.id
  if (scope.type === 'stores') return scope.ids.join(',')
  return null
}

export interface BoardContext {
  scope: DataCenterScope
  meta: BoardMeta
  /** 同比/环比三区间（本期/上期/去年同期） */
  comparison: ComparisonRanges
  /** 是否计算同比/环比（params.withComparison，默认 true） */
  enabled: boolean
}

/** 板块 action 统一前置：校验 scope + 解析时间 + 构建 meta */
export async function prepareBoardContext(
  session: AuthSession,
  params: BoardParams,
): Promise<BoardContext> {
  await validateScope(session, params.scope)
  // 时间参数的服务端复检（#308）：action 收的是客户端原始对象、不经过 parseTimeRange。
  // URL 层对非法值回落本月；到这里还非法只可能是构造出来的请求，报错比静默回落更好排查。
  const timeRange = toTimeRangeInput(params.timeRange)
  if (!timeRange) {
    throw new Error('INVALID_PARAMS: 时间范围无效（须为合法日期且开始不晚于结束）')
  }
  const tr = resolveTimeRange(timeRange)
  const scopeName = await resolveScopeName(params.scope)
  return {
    scope: params.scope,
    meta: {
      scope: {
        type: params.scope.type,
        id: scopeIdOf(params.scope),
        name: scopeName,
      },
      timeRange: {
        start: tr.current.start,
        end: tr.current.end,
        presetLabel: tr.presetLabel,
        // tr 本来就持有这两个区间（toComparisonRanges 取的就是它们），此前只是没往前端送。
        previous: tr.previous ? { start: tr.previous.start, end: tr.previous.end } : null,
        lastYear: tr.lastYear ? { start: tr.lastYear.start, end: tr.lastYear.end } : null,
      },
    },
    comparison: toComparisonRanges(tr),
    enabled: params.withComparison !== false,
  }
}
