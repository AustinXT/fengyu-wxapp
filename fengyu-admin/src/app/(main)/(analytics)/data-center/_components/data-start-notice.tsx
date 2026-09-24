import { AlertTriangle } from "lucide-react"
import {
  DATA_START_AXIS_LABELS,
  type DataStartGroup,
  type DataStartRangeResult,
} from "@/lib/data-center/data-start"

function startText(group: DataStartGroup): string {
  const first = group.stores[0].start
  const last = group.stores[group.stores.length - 1].start
  return first === last ? `${first} 起` : `${first} ~ ${last} 起`
}

function groupTitle(group: DataStartGroup): string {
  return group.stores.map((store) => `${store.storeName}：${store.start} 起`).join("\n")
}

function storeCount(result: DataStartRangeResult): number {
  return new Set(result.groups.flatMap((group) => group.stores.map((store) => store.storeId))).size
}

/**
 * 数据起点提示（#367；#289 复用）。所选期间或较上期的基期早于 scope 内某些门店的数据起点时，
 * 说明这些门店在该期间的数字只覆盖上线之后。判定在 `lib/data-center/data-start.ts` 的
 * `evaluateDataStart`，本组件只负责展示；全部完整时（空数组）不渲染。
 *
 * 第一条受影响的期间逐市场列出门店数与起点（悬停看门店明细），其后的期间（通常是更早的基期，
 * 受影响门店只会更多）只给一句概述，避免同一批门店刷两遍。
 */
export function DataStartNotice({ results }: { results: readonly DataStartRangeResult[] }) {
  if (results.length === 0) return null
  const [first, ...rest] = results

  return (
    <div
      role="note"
      aria-label="数据起点提示"
      className="flex gap-2 rounded-md border border-[#F3C77E] bg-[#FFF7E6] px-4 py-3 text-sm text-[#9A6700]"
    >
      <AlertTriangle className="mt-0.5 size-4 shrink-0" />
      <div className="flex flex-col gap-1">
        <div>
          {first.label}（{first.range.start} ~ {first.range.end}）早于部分门店的数据起点，数据不完整：
          {first.groups.map((group, index) => (
            <span key={`${group.axis}-${group.marketId}`} title={groupTitle(group)}>
              {index > 0 && "；"}
              {DATA_START_AXIS_LABELS[group.axis]} · {group.marketName} {group.stores.length} 家（{startText(group)}）
            </span>
          ))}
        </div>
        {rest.map((result) => (
          <div key={result.label}>
            {result.label}（{result.range.start} ~ {result.range.end}）同样早于数据起点（涉及 {storeCount(result)} 家门店），相关数字不完整。
          </div>
        ))}
      </div>
    </div>
  )
}
