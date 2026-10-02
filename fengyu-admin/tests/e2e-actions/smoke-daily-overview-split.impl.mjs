/**
 * 日常数据一览表（#369）业绩拆分真库冒烟：单测锁得住 SQL 文本、锁不住 SQL 在真实数据形态下的行为
 * （fan-out、分母为 0、无 receipts、sku 为空）。这里在**一个事务里**：
 *   1. 用 lib/data-center/daily-overview-sql.ts 的**同一份** SQL（不抄副本）取全国一个区间的业绩片段，断言逐店 ∑part = total；
 *   2. 对真实款项造三种异常——分母为 0 / 无 receipts / sku 为空——再取一次，断言逐店仍守恒、异常金额落进未分类；
 *   3. ROLLBACK，不留任何改动。
 * 目标库按**集群身份**白名单放行（事务里有写操作，连接串里的主机名 / 隧道 / 代理都不可信）。
 */
import postgres from 'postgres'
import { PgDialect } from 'drizzle-orm/pg-core'
import { dailyOverviewQueries } from '@/lib/data-center/daily-overview-sql'

const DEV_URL = 'postgresql://fengyu:fengyu123@101.34.242.103:5433/fengyu_wxapp'
const url = process.env.E2E_DATABASE_URL || process.env.SMOKE_DATABASE_URL || DEV_URL
/**
 * 放行的集群 system_identifier（pg_control_system()，每个 PG 集群 initdb 时生成、不随主机名 / 端口变）。
 * dev 库 = 101.34.242.103:5433；本地 / 其它测试库用 SMOKE_ALLOW_SYSTEM_ID 显式追加。生产库在拒绝名单里，
 * 即使有人把它加进放行名单也不跑。
 */
const ALLOWED_SYSTEM_IDS = new Set(['7662401863495008426', ...(process.env.SMOKE_ALLOW_SYSTEM_ID ?? '').split(',').filter(Boolean)])
const DENIED_SYSTEM_IDS = new Set(['7662556349675901289']) // prod 118.178.196.26:5433
const range = { start: process.env.START ?? '2026-08-01', end: process.env.END ?? '2026-08-31' }
const session = { roles: [{ role: 'admin', isSuperAdmin: true }], permissions: { scopeStoreIds: [] } }
const dialect = new PgDialect()
const client = postgres(url, { max: 1 })
const cents = (v) => Math.round(Number(v) * 100)
const failures = []

async function fetchParts(tx) {
  const q = dialect.sqlToQuery(dailyOverviewQueries(session, { type: 'all' }, range).performance)
  return tx.unsafe(q.sql, q.params)
}

function assertBalanced(rows, label) {
  // 片段是未舍入的缩放值：先按原值逐店求和、最后只舍入一次，要求与款项合计**逐分相等**（不留随片段数增长的容差）
  const total = new Map()
  const part = new Map()
  for (const r of rows) {
    const m = r.kind === 'total' ? total : part
    m.set(r.store_id, (m.get(r.store_id) ?? 0) + Number(r.amount))
  }
  let bad = 0
  for (const [store, t] of total) {
    if (cents(part.get(store) ?? 0) !== cents(t)) {
      bad += 1
      console.log(`  ✗ ${label} 门店 ${store}：∑part=${part.get(store) ?? 0}，total=${t}`)
    }
  }
  console.log(`${bad === 0 ? '✓' : '✗'} ${label}：${total.size} 家门店逐店 ∑part = total`)
  if (bad) failures.push(label)
}

const [target] = await client`
  SELECT system_identifier::text AS id, inet_server_addr()::text AS addr, inet_server_port() AS port, current_database() AS db
  FROM pg_control_system()`
if (DENIED_SYSTEM_IDS.has(target.id) || !ALLOWED_SYSTEM_IDS.has(target.id)) {
  console.error(`✗ 目标库不在放行名单（system_identifier=${target.id}，${target.addr}:${target.port}/${target.db}），拒绝运行`)
  await client.end()
  process.exit(1)
}

await client.begin(async (tx) => {
  const before = await fetchParts(tx)
  assertBalanced(before, '真实数据')

  const picks = await tx`
    SELECT p.id, p.amount, so.store_id
    FROM sale_order_payments p JOIN sale_orders so ON so.sale_order_id = p.sale_order_id
    JOIN sale_payment_item_receipts r ON r.sale_payment_id = p.id
    WHERE p.status = '已支付' AND p.change_type IN ('首次支付','回款') AND so.sale_order_type IN ('销售单','转换单')
      AND so.legacy_source IS DISTINCT FROM 'workfine'
      AND p.performance_attribution_date BETWEEN ${range.start} AND ${range.end} AND p.amount::numeric > 0
      -- 异常前每条 receipt 都已完整分类（经营类型非空、SKU 挂在有效二级），「未分类增加额 = 款项金额」才精确成立
      AND NOT EXISTS (
        SELECT 1 FROM sale_payment_item_receipts r2
        JOIN sale_items si2 ON si2.sale_item_id = r2.sale_item_id
        LEFT JOIN product_skus sku2 ON sku2.sku_id = si2.sku_id
        LEFT JOIN product_categories pc2 ON pc2.category_id = sku2.category_id
        WHERE r2.sale_payment_id = p.id
          AND (si2.sales_category IS NULL OR pc2.product_kind IS NULL)
      )
    GROUP BY p.id, p.amount, so.store_id HAVING COUNT(r.id) >= 2 AND SUM(r.amount::numeric) <> 0 ORDER BY p.id LIMIT 2`
  // 原本挂在有效二级品项上的子项（sku 非空、分类是二级），且只被这一笔款项收过——置空 sku 后变化可精确归因
  const [lonely] = await tx`
    SELECT r.sale_item_id, r.amount, r.sale_payment_id, so.store_id, si.sales_category::text AS sales_category, sku.category_id
    FROM sale_payment_item_receipts r
    JOIN sale_order_payments p ON p.id = r.sale_payment_id
    JOIN sale_orders so ON so.sale_order_id = p.sale_order_id
    JOIN sale_items si ON si.sale_item_id = r.sale_item_id
    JOIN product_skus sku ON sku.sku_id = si.sku_id
    JOIN product_categories pc ON pc.category_id = sku.category_id AND pc.product_kind IS NOT NULL
    WHERE p.status = '已支付' AND p.change_type IN ('首次支付','回款') AND so.sale_order_type IN ('销售单','转换单')
      AND so.legacy_source IS DISTINCT FROM 'workfine'
      AND p.performance_attribution_date BETWEEN ${range.start} AND ${range.end} AND r.amount::numeric > 0
      AND si.sales_category IS NOT NULL
      AND r.sale_payment_id NOT IN ${tx(picks.map((pick) => pick.id).concat([0]))}
      AND NOT EXISTS (SELECT 1 FROM sale_payment_item_receipts o WHERE o.sale_item_id = r.sale_item_id AND o.id <> r.id)
    ORDER BY r.id LIMIT 1`
  if (picks.length < 2 || !lonely) {
    // 造不出异常就等于没测兜底：算失败，不静默当 PASS（换一个有数据的区间：START=… END=…）
    failures.push(`区间 ${range.start}~${range.end} 内可造异常的款项不足`)
    throw new Error('ROLLBACK')
  }
  const [a, b] = picks
  const check = (label, ok) => {
    console.log(`${ok ? '✓' : '✗'} ${label}`)
    if (!ok) failures.push(label)
  }
  const unclassifiedWhole = (rows, store) => rows
    .filter((r) => r.kind === 'part' && r.store_id === store && r.sales_category === null && r.category_id === null)
    .reduce((sum, r) => sum + Number(r.amount), 0)

  /**
   * 三种异常各自在独立 savepoint 里造数、各取 before/after、断言后回滚到 savepoint——
   * 互不污染（同店同分组时，一个场景挪走的金额不会被算进另一个场景的增减）。
   */
  async function scenario(label, mutate, verify) {
    await tx.savepoint(async (sp) => {
      const scenarioBefore = await fetchParts(sp)
      await mutate(sp)
      const scenarioAfter = await fetchParts(sp)
      assertBalanced(scenarioAfter, `${label} 后`)
      verify(scenarioBefore, scenarioAfter)
      throw new Error('SAVEPOINT_ROLLBACK')
    }).catch((error) => {
      if (error.message !== 'SAVEPOINT_ROLLBACK') throw error
    })
  }

  // ① 分母为 0：第一条 receipt 改成其余之和的相反数 → 该款项整笔以 (∅, ∅) 出现
  await scenario('① 分母为 0', async (sp) => {
    const ra = await sp`SELECT id, amount FROM sale_payment_item_receipts WHERE sale_payment_id = ${a.id} ORDER BY id`
    const rest = ra.slice(1).reduce((sum, r) => sum + Number(r.amount), 0)
    await sp`UPDATE sale_payment_item_receipts SET amount = ${(-rest).toFixed(2)} WHERE id = ${ra[0].id}`
  }, (before, after) => {
    const gained = unclassifiedWhole(after, a.store_id) - unclassifiedWhole(before, a.store_id)
    check(`① 分母为 0 的款项 ¥${a.amount} 整笔进未分类（+${gained.toFixed(2)}）`, cents(gained) === cents(a.amount))
  })

  // ② 无 receipts：删掉该款项全部 receipts（先删挂在上面的分配行）→ 整笔以 (∅, ∅) 出现
  await scenario('② 无 receipts', async (sp) => {
    await sp`DELETE FROM sale_payment_item_allocations WHERE sale_payment_item_receipt_id IN (SELECT id FROM sale_payment_item_receipts WHERE sale_payment_id = ${b.id})`
    await sp`DELETE FROM sale_payment_item_receipts WHERE sale_payment_id = ${b.id}`
  }, (before, after) => {
    const gained = unclassifiedWhole(after, b.store_id) - unclassifiedWhole(before, b.store_id)
    check(`② 无 receipts 的款项 ¥${b.amount} 整笔进未分类（+${gained.toFixed(2)}）`, cents(gained) === cents(b.amount))
  })

  // ③ sku 置空：该店（原经营类型, 原二级）减少额 = （原经营类型, 未分类品项）增加额，且 > 0
  await scenario('③ sku 为空', async (sp) => {
    await sp`UPDATE sale_items SET sku_id = NULL WHERE sale_item_id = ${lonely.sale_item_id}`
  }, (before, after) => {
    const slice = (rows, categoryId) => rows
      .filter((r) => r.kind === 'part' && r.store_id === lonely.store_id && r.sales_category === lonely.sales_category && r.category_id === categoryId)
      .reduce((sum, r) => sum + Number(r.amount), 0)
    const moved = slice(before, lonely.category_id) - slice(after, lonely.category_id)
    const gained = slice(after, null) - slice(before, null)
    check(`③ sku 置空的子项（¥${lonely.amount}）按比例份额从原二级移到未分类品项（${moved.toFixed(2)}）`,
      moved > 0 && cents(moved) === cents(gained))
  })
  throw new Error('ROLLBACK')
}).catch((error) => {
  if (error.message !== 'ROLLBACK') throw error
})
await client.end()
console.log('已回滚，未留任何改动')
if (failures.length) {
  console.error(`✗ 失败 ${failures.length} 项：${failures.join('；')}`)
  process.exit(1)
}
console.log('✓ PASS')
