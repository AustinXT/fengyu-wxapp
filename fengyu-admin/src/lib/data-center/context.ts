/**
 * 数据中心板块上下文预备（scope 校验 + 时间解析 + meta 构建）
 *
 * 每个板块 action 第一步调用 prepareBoardContext，统一：
 *   1. validateScope —— UI 选的 scope 必须在账号权限内（越权抛 PermissionError）
 *   2. resolveTimeRange —— 解析本期/上期/去年同期
 *   3. resolveScopeName —— scope 显示名（回显）
 * 返回 meta + comparison 区间 + enabled，板块只管自己的指标查询。
 *
 * 注意：放在 lib/ 而非 actions/，因含纯/DB 辅助函数（actions/ 的 ESLint 规则要求每个 export 都 HOF 包装）。
 */
import { db } from '@/db'
import { orgNodes, stores } from '@db/org'
import { eq } from 'drizzle-orm'
import { isAdminScope, expandVisibleMarketIds, PermissionError } from '@/lib/permissions'
import type { AuthSession } from '@/lib/types'
import type { BoardMeta, BoardParams, DataCenterScope } from './types'
import { resolveTimeRange } from './time-range'
import { toComparisonRanges, type ComparisonRanges } from './comparison'

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
 * 修法是让 `PermissionError.digest` 带上完整 message、`(main)/error.tsx` 改判前缀 —— 那会动到
 * 全局 401/403 渲染链路，风险面远超一个文案 bug，故另开 issue，不在 #133 内做。
 */
export async function validateScope(session: AuthSession, scope: DataCenterScope): Promise<void> {
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
  // store
  if (!session.permissions.scopeStoreIds.includes(scope.id)) {
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
  const [row] = await db
    .select({ name: stores.storeName })
    .from(stores)
    .where(eq(stores.storeId, scope.id))
    .limit(1)
  return row?.name ?? '未知门店'
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
  const tr = resolveTimeRange(params.timeRange)
  const scopeName = await resolveScopeName(params.scope)
  return {
    scope: params.scope,
    meta: {
      scope: {
        type: params.scope.type,
        id: params.scope.type === 'market' || params.scope.type === 'store' ? params.scope.id : null,
        name: scopeName,
      },
      timeRange: { start: tr.current.start, end: tr.current.end, presetLabel: tr.presetLabel },
    },
    comparison: toComparisonRanges(tr),
    enabled: params.withComparison !== false,
  }
}
