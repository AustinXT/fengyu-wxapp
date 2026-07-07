
import { db } from '@/db'
import { orgNodes, stores } from '@db/org'
import { eq } from 'drizzle-orm'
import { isAdminScope, expandVisibleMarketIds, PermissionError } from '@/lib/permissions'
import type { AuthSession } from '@/lib/types'
import type { BoardMeta, BoardParams, DataCenterScope } from './types'
import { resolveTimeRange } from './time-range'
import { toComparisonRanges, type ComparisonRanges } from './comparison'


export function getScopeTopLevel(session: AuthSession): 'all' | 'market' | 'store' {
  if (isAdminScope(session) || session.roles.some((r) => r.scopeType === '总部')) return 'all'
  if (session.roles.some((r) => r.scopeType === '市场')) return 'market'
  return 'store'
}


export async function validateScope(session: AuthSession, scope: DataCenterScope): Promise<void> {
  if (isAdminScope(session)) return
  if (session.roles.some((r) => r.scopeType === '总部')) return

  if (scope.type === 'all') {
    throw new PermissionError('PERMISSION_DENIED: 无权查看全部数据')
  }
  if (scope.type === 'market') {
    const visible = await expandVisibleMarketIds(session) 
    if (visible === null) return
    if (!visible.includes(scope.id)) {
      throw new PermissionError('PERMISSION_DENIED: 越权访问其他市场数据')
    }
    return
  }
  
  if (!session.permissions.scopeStoreIds.includes(scope.id)) {
    throw new PermissionError('PERMISSION_DENIED: 越权访问其他门店数据')
  }
}


export async function resolveScopeName(scope: DataCenterScope): Promise<string> {
  if (scope.type === 'all') return '全部'
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
  
  comparison: ComparisonRanges
  
  enabled: boolean
}


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
        id: params.scope.type === 'all' ? null : params.scope.id,
        name: scopeName,
      },
      timeRange: { start: tr.current.start, end: tr.current.end, presetLabel: tr.presetLabel },
    },
    comparison: toComparisonRanges(tr),
    enabled: params.withComparison !== false,
  }
}
