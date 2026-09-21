import type { ComponentType } from "react"
import { notFound, redirect } from "next/navigation"
import { getDataCenterScopeOptions } from "@/actions/data-center/shared"
import {
  DATA_CENTER_BOARD_LABELS,
  firstQueryValue,
  parseBoard,
  parseScope,
  type DataCenterTab,
} from "@/lib/data-center/params"
import { resolveDefaultDataCenterScope } from "@/lib/data-center/scope-options"
import type { DataCenterScope } from "@/lib/data-center/types"
import { Card, CardContent } from "@/components/ui/card"
import { ScopeTimeFilter } from "../_components/scope-time-filter"
import { SalesBoard } from "../_components/sales/sales-board"
import { CustomerBoard } from "../_components/customer/customer-board"
import { EfficiencyBoard } from "../_components/efficiency/efficiency-board"
import { ProductBoard } from "../_components/product/product-board"

export const dynamic = "force-dynamic"

/**
 * 查表而非三元：`Record<DataCenterTab, …>` 让新增板块时漏配在 tsc 就报错。
 * 三元写法的 default 分支会把漏配的板块静默渲染成销售，和 parseBoard 想堵的是同一类洞。
 */
const BOARD_COMPONENTS: Record<DataCenterTab, ComponentType> = {
  sales: SalesBoard,
  customer: CustomerBoard,
  efficiency: EfficiencyBoard,
  product: ProductBoard,
}

/**
 * 默认 scope 必须是「redirect 后 parseScope 还认得出」的具体值，否则下一跳又回落 'all'、
 * needsDefaultScope 再次为真 —— 无限重定向，浏览器直接转死。
 *
 * `resolveDefaultDataCenterScope` 的契约本就保证非总部只会给 authorized/store（storeId 是 DB uuid），
 * 这里显式校验一次，把「依赖另一个文件的隐式契约」变成「不满足就降级成空态」。
 */
function isUsableDefaultScope(scope: DataCenterScope | null): scope is Exclude<DataCenterScope, { type: 'all' }> {
  if (scope === null || scope.type === "all") return false
  return scope.type === "authorized" || Boolean(scope.id)
}

/**
 * 数据中心板块页（Server Component）。
 * - 板块由路径段决定（侧边栏二级菜单直达），非法段 notFound——动态段不收口会让 /data-center/xxx 静默渲染销售
 * - getDataCenterScopeOptions 兼任权限闸门（无 data_center:dashboard → PermissionError → 403）
 * - scope/时间/同比环比 状态由公共筛选器写 URL，板块组件读 URL 取数
 *
 * 默认 scope 解析：非总部账号在 URL 无有效 scope（默认 'all'）时，单店落到
 * 具体门店，多店落到 authorized 授权汇总。否则 board action 的 validateScope 对「非 admin + scope='all'」会抛
 * PERMISSION_DENIED，生产脱敏后表现为板块内联「数据加载失败」（店长/市场财务曾踩过）。
 * 对齐 staff mgmt-dashboard：非总部绝不以 'all' 取数，入口解析出具体 scope。
 * ⚠️ redirect 目标必须带上当前 board——退回裸路径或硬编码 sales 会让店长一点「客量」就被弹回「销售」。
 */
export default async function Page({
  params,
  searchParams,
}: {
  params: Promise<{ board: string }>
  searchParams: Promise<Record<string, string | string[] | undefined>>
}) {
  const board = parseBoard((await params).board)
  if (!board) notFound()

  const query = await searchParams
  const scopeOptions = await getDataCenterScopeOptions()

  // 非总部账号 + URL 无有效 scope → 落到默认 scope（redirect 一次，板块挂载时 URL 已具体）
  const rawScope = parseScope({
    scope: firstQueryValue(query.scope),
    scopeId: firstQueryValue(query.scopeId),
  })
  const needsDefaultScope = rawScope.type === "all" && scopeOptions.topLevel !== "all"
  const defaultScope = resolveDefaultDataCenterScope(scopeOptions)
  const usableDefaultScope = isUsableDefaultScope(defaultScope) ? defaultScope : null
  const noViewableScope = scopeOptions.topLevel !== "all" && usableDefaultScope === null
  if (needsDefaultScope && usableDefaultScope) {
    const next = new URLSearchParams()
    for (const [k, v] of Object.entries(query)) {
      // tab 是裸路径时代的遗留参数，板块已由路径承载；不剔除会让它永久滞留在 URL 上
      if (k === "scope" || k === "scopeId" || k === "tab") continue
      const value = firstQueryValue(v)
      if (!value) continue
      next.set(k, value)
    }
    next.set("scope", usableDefaultScope.type)
    if (usableDefaultScope.type === "market" || usableDefaultScope.type === "store") {
      next.set("scopeId", usableDefaultScope.id)
    }
    redirect(`/data-center/${board}?${next.toString()}`)
  }

  const Board = BOARD_COMPONENTS[board]

  return (
    <div className="flex flex-col gap-4">
      <h1 className="text-xl font-semibold text-[var(--foreground)]">{DATA_CENTER_BOARD_LABELS[board]}</h1>
      <ScopeTimeFilter scopeOptions={scopeOptions} />
      {noViewableScope ? (
        <Card>
          <CardContent className="p-8 text-center text-sm text-[var(--muted-foreground)]">
            当前账号暂无可查看的数据范围
          </CardContent>
        </Card>
      ) : (
        <Board />
      )}
    </div>
  )
}
