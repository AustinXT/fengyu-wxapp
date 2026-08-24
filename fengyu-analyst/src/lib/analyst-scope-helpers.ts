import "server-only"

import { NextResponse } from "next/server"
import type { AuthSession } from "./types"
import {
  getAnalystScopeOptions,
  getEffectiveAnalystScope,
  resolveAnalystScopeFromParams,
  validateAnalystScopeWithOptions,
  type AnalystScope,
} from "./analyst-scope"

export interface ResolvedAnalystScope {
  scope: AnalystScope
  session: AuthSession
}

/**
 * 从 URL searchParams 解析并验证 analyst scope，避免重复查询
 * 用于 export routes 和其他需要 scope 校验的 API
 */
export async function withAnalystScope(
  session: AuthSession,
  searchParams: URLSearchParams,
): Promise<ResolvedAnalystScope> {
  const requestedScope = await resolveAnalystScopeFromParams({
    scope: searchParams.get("scope"),
    scopeId: searchParams.get("scopeId"),
    market: searchParams.get("market"),
    store: searchParams.get("store"),
  })

  const scopeOptions = await getAnalystScopeOptions(session)
  const scope = getEffectiveAnalystScope(requestedScope, scopeOptions)

  if (!scope) {
    throw new Error("PERMISSION_DENIED: 无可用的数据范围")
  }

  try {
    validateAnalystScopeWithOptions(session, scope, scopeOptions)
  } catch (error) {
    throw error
  }

  return { scope, session }
}

/**
 * 包装 withAnalystScope 并返回标准的 403 响应
 */
export async function withAnalystScopeOrDeny(
  session: AuthSession,
  searchParams: URLSearchParams,
  logPrefix: string,
): Promise<ResolvedAnalystScope | NextResponse> {
  try {
    return await withAnalystScope(session, searchParams)
  } catch (error) {
    console.error(`[${logPrefix}] scope validation failed:`, error)
    return NextResponse.json({ error: "PERMISSION_DENIED" }, { status: 403 })
  }
}
