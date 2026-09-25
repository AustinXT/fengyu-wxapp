import type { ComponentType } from "react"
import { notFound, redirect } from "next/navigation"
import { getDataCenterScopeOptions } from "@/actions/data-center/shared"
import { DATA_CENTER_BOARD_LABELS, parseBoard, type DataCenterTab } from "@/lib/data-center/params"
import { resolveDataCenterEntry } from "@/lib/data-center/entry"
import { ScopeTimeFilter } from "../_components/scope-time-filter"
import { ScopeEmptyState } from "../_components/scope-empty-state"
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

  // 默认 scope 补齐 + 重复 key 规范化（入口控制流与经营明细报表页共用，见 lib/data-center/entry.ts）。
  // 遗留的 `tab` 参数一并剔除：板块已由路径承载。
  const entry = resolveDataCenterEntry(`/data-center/${board}`, query, scopeOptions, ["tab"])
  if (entry.kind === "redirect") redirect(entry.url)
  // 无可查看范围 / 选中已停用门店（#293）：渲染空态、不挂板块，板块内的取数与导出都不会发生。
  const { noViewableScope, inactiveStore, defaultScopeHref } = entry

  const Board = BOARD_COMPONENTS[board]

  return (
    <div className="flex flex-col gap-4">
      <h1 className="text-xl font-semibold text-[var(--foreground)]">{DATA_CENTER_BOARD_LABELS[board]}</h1>
      <ScopeTimeFilter scopeOptions={scopeOptions} />
      {noViewableScope || inactiveStore ? (
        <ScopeEmptyState inactiveStore={inactiveStore} defaultScopeHref={defaultScopeHref} />
      ) : (
        <Board />
      )}
    </div>
  )
}
