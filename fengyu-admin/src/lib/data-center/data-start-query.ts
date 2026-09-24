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
 * 直接聚合 sale_order_payments ⋈ sale_orders（prod 实测约 25ms）——同口径走
 * sale_order_performance_events 视图要 1.7s，结果逐店一致（2026-09-25 核对 37 家 0 差异）。
 */
const CACHE_TTL_MS = 10 * 60 * 1000
let cache: { value: StoreDataStarts; expiresAt: number } | null = null

type StartRow = { store_id: string; start: string | null }

export async function loadStoreDataStarts(now: number = Date.now()): Promise<StoreDataStarts> {
  if (cache && cache.expiresAt > now) return cache.value

  const [performanceRows, serviceRows] = await Promise.all([
    // 业绩轴：已支付款项的归属日期；寄存单是存量录入（最早 2026-07-03），不代表门店上线，剔除。
    db.execute(sql`
      SELECT so.store_id, to_char(MIN(p.performance_attribution_date), 'YYYY-MM-DD') AS start
        FROM sale_order_payments p
        JOIN sale_orders so ON so.sale_order_id = p.sale_order_id
       WHERE p.status = '已支付'
         AND so.sale_order_type <> '寄存单'
       GROUP BY so.store_id
    `),
    // 服务轴：服务单业务日期
    db.execute(sql`
      SELECT store_id, to_char(MIN(service_date), 'YYYY-MM-DD') AS start
        FROM service_orders
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

  cache = { value, expiresAt: now + CACHE_TTL_MS }
  return value
}

/** 仅测试用：清空进程缓存。 */
export function resetStoreDataStartsCache(): void {
  cache = null
}
