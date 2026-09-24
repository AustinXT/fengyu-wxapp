/**
 * 各门店数据起点的取数（#367）。判定逻辑在纯函数 `data-start.ts`，这里只负责查库 + 进程缓存。
 *
 * 放在 lib/ 而非 actions/：actions 目录的 ESLint 规则要求每个 export 都 HOF 包装；
 * 对外的 Server Action 入口是 `actions/data-center/shared.ts` 的 `getDataStartDates`。
 */
import { sql } from 'drizzle-orm'
import { db } from '@/db'
import type { DataStartAxis, StoreDataStarts } from './data-start'

/**
 * 起点只在新门店 / 新市场上线时才会变，10 分钟缓存足够；
 * 直接聚合 sale_order_payments ⋈ sale_orders（prod 实测约 50ms）——同过滤条件走
 * sale_order_performance_events 视图要 1.7s（视图就是二者的直投影，结果逐店一致）。
 * 2026-09-25 prod 各市场起点：南昌凤御 07-08、自贡 07-28、九江 业绩 07-30 / 服务 07-28、
 * 南昌易大师 08-23、昭通 业绩 09-14 / 服务暂无——与 #367 表格一致。
 */
const CACHE_TTL_MS = 10 * 60 * 1000
let cache: { value: StoreDataStarts; expiresAt: number } | null = null
/** 并发首请求 / 过期瞬间共用同一次查询，不各自跑两条全表聚合 */
let inflight: Promise<StoreDataStarts> | null = null

type StartRow = { store_id: string; start: string | null }

async function queryStoreDataStarts(): Promise<StoreDataStarts> {
  const [performanceRows, serviceRows] = await Promise.all([
    // 业绩轴：与销售板门店业绩（sales.ts runStoreRevenue）同一组单据类型 / 款项类型，按款项归属日期。
    // 寄存单是存量录入（最早 2026-07-03），储值卡抵扣、内部单不计业绩，都不代表门店业绩起点。
    // 两组集合由 data-start-query.test.ts 与 sales.ts 逐字比对守护。
    db.execute(sql`
      SELECT so.store_id, to_char(MIN(p.performance_attribution_date), 'YYYY-MM-DD') AS start
        FROM sale_order_payments p
        JOIN sale_orders so ON so.sale_order_id = p.sale_order_id
       WHERE p.status = '已支付'
         AND p.change_type IN ('首次支付', '回款', '退款')
         AND so.sale_order_type IN ('销售单', '转换单', '充值单')
       GROUP BY so.store_id
    `),
    // 服务轴：已完成服务单的业务日期（与客量 / 人效板服务类指标、analyst 割点口径一致）
    db.execute(sql`
      SELECT store_id, to_char(MIN(service_date), 'YYYY-MM-DD') AS start
        FROM service_orders
       WHERE status = '已完成'
       GROUP BY store_id
    `),
  ])

  const value: StoreDataStarts = {}
  const collect = (rows: unknown, axis: DataStartAxis) => {
    for (const row of rows as StartRow[]) {
      if (!row.start) continue
      value[row.store_id] = { ...value[row.store_id], [axis]: row.start }
    }
  }
  collect(performanceRows, 'performance')
  collect(serviceRows, 'service')

  // 缓存对象跨请求、跨账号共享：冻结，防止调用方就地改写串到别人的结果里
  for (const entry of Object.values(value)) Object.freeze(entry)
  return Object.freeze(value)
}

export async function loadStoreDataStarts(now: number = Date.now()): Promise<StoreDataStarts> {
  if (cache && cache.expiresAt > now) return cache.value
  inflight ??= queryStoreDataStarts()
    .then((value) => {
      cache = { value, expiresAt: now + CACHE_TTL_MS }
      return value
    })
    .finally(() => {
      inflight = null
    })
  return inflight
}

/** 仅测试用：清空进程缓存。 */
export function resetStoreDataStartsCache(): void {
  cache = null
  inflight = null
}
