'use strict'

/**
 * 款项业绩归属日期的迁移就绪守卫（fail-closed）。
 *
 * 背景：查询侧一律直读 `sale_order_payments.performance_attribution_date`（迁移 0039/0040 收敛）。
 * 但 `0037` 的回填带 `WHERE change_type <> '首次支付'`，**首次支付行的该列一直是 NULL**，
 * 直到 `0039_payment_attribution_date_always_set` 的回填①才补上。
 *
 * 于是在未 apply 0039 的库上：绝大多数订单一次付清、唯一的已支付款项行就是首次支付行 →
 * `NULL >= $1::date` 求值为 NULL → 条件为假 → **日期筛选静默返回近乎空集，且不报错**。
 * 运营会把「这个月没订单」当成业务事实。2026-09-14 dev 库实测：
 * 首次支付行 1628 行，NULL 率 **100%**；某月订单列表旧口径 3117 单 → 新口径 1830 单，
 * 差额里 1218 单是状态「已支付」的正常订单。
 *
 * 因此带日期筛选的查询在跑之前必须先过本守卫，宁可报错也不出空数据。
 *
 * 缓存策略：**只缓存"已就绪"**。未就绪时每次重探——这样 DBA 跑完迁移后，
 * 无需等云函数容器回收就能立刻恢复；而未就绪时本来就要报错，多一次查询无所谓。
 */

let ready = false

/** 探针走 `uq_sop_first_payment` 部分索引（谓词恰为 change_type/status 这两个条件），代价可忽略 */
const PROBE_SQL = `
  SELECT EXISTS (
    SELECT 1
      FROM sale_order_payments
     WHERE change_type = '首次支付'
       AND status = '已支付'
       AND performance_attribution_date IS NULL
  ) AS has_gap`

/**
 * @param {{ query: (sql: string, params?: unknown[]) => Promise<any[]> }} pg
 * @throws {Error} `INVALID_STATE: MIGRATION_REQUIRED: ...` 当库未 apply 0039
 */
async function assertPaymentAttributionReady(pg) {
  if (ready) return
  const rows = await pg.query(PROBE_SQL)
  if (rows[0] && rows[0].has_gap) {
    throw new Error(
      'INVALID_STATE: MIGRATION_REQUIRED: 业绩归属日期迁移（0039/0040）尚未执行，'
      + '按日期筛选会漏掉绝大多数订单，已阻止返回错误数据。请先执行数据库迁移。',
    )
  }
  ready = true
}

/** 仅供单测重置模块级缓存 */
function __resetAttributionGuardCache() {
  ready = false
}

module.exports = {
  assertPaymentAttributionReady,
  __resetAttributionGuardCache,
}
