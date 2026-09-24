/**
 * 数据起点判定（#367，纯函数；#289 与各经营明细报表页共用）。
 *
 * 线上系统的业务数据不是同一天开始的：款项最早 2026-07-03（寄存单录入日）、销售 / 服务单最早 2026-07-08，
 * 各市场按上线先后更晚（南昌凤御 07-08、自贡 07-28、九江 07-28~30、南昌易大师 08-23、昭通 09-14），
 * 同一市场内各门店还有先后。所选期间（或较上期的基期）只要早于 scope 内某家门店的数据起点，
 * 该门店在这段期间的数字就只覆盖上线之后——跨割点的比率与环比会系统性失真（见 memory
 * `project-data-timeline-cutoff-20260703`），必须在界面上提示。
 *
 * 起点按「指标所用的时间轴」分开取：
 *   performance  业绩 / 款项，按款项归属日期，剔除寄存单（寄存单是存量录入，不代表上线）
 *   service      服务单，按 service_date
 * 某门店在某条轴上一条数据都没有时不参与该轴判定（没有起点可比，列出来只会永久误报）。
 */
import type { ScopeStoreEntry } from './scope-options'
import type { ResolvedRange } from './types'

export { scopeStores } from './scope-options'

export const DATA_START_AXES = ['performance', 'service'] as const
export type DataStartAxis = (typeof DATA_START_AXES)[number]

export const DATA_START_AXIS_LABELS: Record<DataStartAxis, string> = {
  performance: '业绩',
  service: '服务',
}

/** 门店 → 各轴数据起点（YYYY-MM-DD）。没有该轴数据的门店不带该键。 */
export type StoreDataStarts = Record<string, Partial<Record<DataStartAxis, string>>>

export type ScopeStore = ScopeStoreEntry

export interface DataStartGroup {
  axis: DataStartAxis
  marketId: string
  marketName: string
  /** 起点晚于期间起点的门店（按起点、门店名排序） */
  stores: Array<{ storeId: string; storeName: string; start: string }>
}

export interface DataStartRangeResult {
  label: string
  range: ResolvedRange
  groups: DataStartGroup[]
}

/** 单段期间在某条轴上受影响的门店，按市场分组。 */
function groupsFor(
  range: ResolvedRange,
  axis: DataStartAxis,
  stores: readonly ScopeStore[],
  starts: StoreDataStarts,
): DataStartGroup[] {
  const byMarket = new Map<string, DataStartGroup>()
  for (const store of stores) {
    const start = starts[store.storeId]?.[axis]
    if (!start || start <= range.start) continue
    let group = byMarket.get(store.marketId)
    if (!group) {
      group = { axis, marketId: store.marketId, marketName: store.marketName, stores: [] }
      byMarket.set(store.marketId, group)
    }
    group.stores.push({ storeId: store.storeId, storeName: store.storeName, start })
  }
  const groups = Array.from(byMarket.values())
  for (const group of groups) {
    group.stores.sort((a, b) => a.start.localeCompare(b.start) || a.storeName.localeCompare(b.storeName, 'zh-CN'))
  }
  // 起点早的市场在前；同起点按市场名
  return groups.sort((a, b) => a.stores[0].start.localeCompare(b.stores[0].start) || a.marketName.localeCompare(b.marketName, 'zh-CN'))
}

/**
 * 期间是否早于（或跨过）scope 内任一门店在该轴上的数据起点。
 * 各页面据此把基期值置为 null，交给 `resolveDeltaDisplay` 输出「--」（#369 / #310）。
 */
export function isRangeBeforeDataStart(
  range: ResolvedRange,
  axis: DataStartAxis,
  stores: readonly ScopeStore[],
  starts: StoreDataStarts,
): boolean {
  return stores.some((store) => {
    const start = starts[store.storeId]?.[axis]
    return Boolean(start && start > range.start)
  })
}

/**
 * 逐段期间判定，只返回受影响的期间（全部完整时返回空数组，页面不渲染提示）。
 *
 * @param ranges  按展示顺序传入，如 `[{ label: '所选期间', range: current }, { label: '较上期基期', range: previous }]`；
 *                主表的年度累计列另传 `{ label: '年度累计', range: ytd }`
 */
export function evaluateDataStart(input: {
  ranges: ReadonlyArray<{ label: string; range: ResolvedRange }>
  axes: readonly DataStartAxis[]
  stores: readonly ScopeStore[]
  starts: StoreDataStarts
}): DataStartRangeResult[] {
  const results: DataStartRangeResult[] = []
  for (const { label, range } of input.ranges) {
    const groups = input.axes.flatMap((axis) => groupsFor(range, axis, input.stores, input.starts))
    if (groups.length > 0) results.push({ label, range, groups })
  }
  return results
}
