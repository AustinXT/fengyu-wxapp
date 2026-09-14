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
 * 并发的冷请求共享同一个在途 Promise（`inflight`），避免 max=5 的连接池被重复探针占满。
 *
 * ## 为什么探数据而不探 `chk_sop_attribution_date_present` 约束（0040 的产物）
 *
 * 因为**只 apply 了 0039 的库是可以正常工作的**——0039 的回填①已补齐首次支付行，
 * 它的 BEFORE trigger 也保证新行恒有值，查询侧直读该列不会出错。
 * prod 当前正是这个状态（0039 已 apply、0040 未 apply）。
 * 若改探 0040 的约束，会把这类**健康的库**误判成未就绪而全面报错。
 * 数据探针的语义更贴近我们真正关心的失败模式：「首次支付行有没有归属日期」。
 *
 * 已知取舍（codex 评审提出）：探针为真不等价于「0040 已执行」。缺 0040 时少了 CHECK 兜底，
 * 理论上可能再产生 NULL 行——但 0039 的 BEFORE trigger 已覆盖全部写入路径，
 * 该风险由 0040 的迁移计划承接，不由本守卫承接。
 */

let ready = false
/** 在途探针的 Promise，供并发冷请求共享（codex P3：防连接池穿透） */
let inflight = null

/**
 * 探针谓词的前两个条件与 `uq_sop_first_payment` 部分索引完全一致
 * （btree(sale_order_id) WHERE change_type='首次支付' AND status='已支付'），planner 可用它。
 *
 * 代价（GLM 评审要求量化，勿改回「可忽略」）：该索引不含 `performance_attribution_date`，每行需回表。
 * - 未迁移库：首行即命中 NULL，EXISTS 立刻短路（dev 实测 NULL 率 100%）。
 * - 已迁移库：无 NULL 可命中，须扫完全部「首次支付 + 已支付」行才能返回 false，
 *   即 O(已支付订单数) 次回表（dev 1628 行），随单量线性增长。
 * 因每个冷容器只执行一次（就绪即缓存），稳态开销≈0。
 */
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
  if (!inflight) {
    // 失败也要清掉 inflight，否则一次瞬时故障会把后续所有请求钉死在同一个 rejected Promise 上
    inflight = pg.query(PROBE_SQL).finally(() => { inflight = null })
  }
  const rows = await inflight
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
  inflight = null
}

module.exports = {
  assertPaymentAttributionReady,
  __resetAttributionGuardCache,
}
