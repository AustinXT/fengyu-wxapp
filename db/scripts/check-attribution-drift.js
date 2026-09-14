#!/usr/bin/env node

/**
 * check-attribution-drift.js — 款项业绩归属日期收敛前的迁移前体检（read-only）
 *
 * 背景：issue #137。迁移 0040 把两个业绩视图的 `performance_date` 从
 *   「CASE 三分支 + LATERAL 配对」改成直读 `sale_order_payments.performance_attribution_date`，
 *   并给该列加上 `chk_sop_attribution_date_present`（等价 NOT NULL）。
 *
 *   直读能不能替换 CASE，取决于两件事在目标库上是否成立：
 *     D1 该列与旧 CASE 表达式逐行相等（唯一可能漂移的是储值卡抵扣：
 *        旧视图对卡行**优先取配对主流水**的归属日，优先级高于自身列值）
 *     D2 该列没有 NULL（否则 CHECK 约束会让 0040 直接失败）
 *   顺带检查 0040 新增的巡检项 I6：
 *     D3 首次支付行的归属日期 = 所属订单的归属日期
 *
 *   0040 内部有同样的自检并会 RAISE 回滚，所以本脚本只是**提前**知道结果，
 *   免得在维护窗口里才发现要人工判读。
 *
 * 用法（三库都要各跑一遍，必须显式传 DATABASE_URL）：
 *   DATABASE_URL="postgresql://fengyu:***@101.34.242.103:5433/fengyu_wxapp" \
 *     node db/scripts/check-attribution-drift.js          # test
 *   DATABASE_URL="postgresql://fengyu:***@118.178.196.26:5433/fengyu_wxapp" \
 *     node db/scripts/check-attribution-drift.js          # prod
 *
 * 退出码：0 = 可以迁（含"只有 D3 脱拍、会被 0040 的 ① 回填自动拉齐"这种情况）；
 *         1 = 真阻塞（D2 有 NULL，或 D1 里有非首次支付的漂移）；2 = 脚本自身出错。
 *
 * ⚠ 本脚本的 D1 与迁移 0040 的 ② 自检是**同一条 SQL 的两份副本**，改一处必须同步另一处。
 */

const { Client } = require('pg')

const CONNECTION_STRING = process.env.DATABASE_URL || process.env.PG_CONNECTION_STRING

/** 已知业务库，仅用于在输出里标明打的是哪一套，防止对着错的库下结论。 */
const KNOWN_HOSTS = {
  '118.178.196.26': 'prod',
  '101.34.242.103': 'test（dev 自 2026-09-01 起也迁到这台，两者同库）',
  '47.113.202.7': 'dev（旧拓扑；db/CLAUDE.md 仍记为在用，以 envs/ 的实际连接串为准）',
}

const SAMPLE_LIMIT = 20

function log(msg) {
  console.log(`[ATTR-DRIFT] ${msg}`)
}

/** D1：直读列 vs 旧 CASE 表达式（与 0040 迁移内自检同一条 SQL）。 */
const DRIFT_SQL = `
  WITH legacy AS (
    SELECT
      sop.id,
      sop.sale_order_id,
      sop.change_type::text AS change_type,
      sop.status::text      AS status,
      sop.performance_attribution_date AS column_value,
      CASE
        WHEN sop.change_type = '首次支付' THEN so.performance_attribution_date
        WHEN sop.change_type = '储值卡抵扣' AND sop.status = '已支付'
          AND paired_payment.performance_date IS NOT NULL
          THEN paired_payment.performance_date
        ELSE COALESCE(
          sop.performance_attribution_date,
          (sop.paid_at AT TIME ZONE 'Asia/Shanghai')::date,
          (sop.created_at AT TIME ZONE 'Asia/Shanghai')::date
        )
      END AS legacy_value
    FROM sale_order_payments sop
    JOIN sale_orders so ON so.sale_order_id = sop.sale_order_id
    LEFT JOIN LATERAL (
      SELECT
        CASE
          WHEN primary_payment.change_type = '首次支付'
            THEN so.performance_attribution_date
          ELSE COALESCE(
            primary_payment.performance_attribution_date,
            (primary_payment.paid_at AT TIME ZONE 'Asia/Shanghai')::date,
            (primary_payment.created_at AT TIME ZONE 'Asia/Shanghai')::date
          )
        END AS performance_date
      FROM sale_order_payments primary_payment
      WHERE sop.change_type = '储值卡抵扣'
        AND primary_payment.sale_order_id = sop.sale_order_id
        AND primary_payment.change_type IN ('首次支付', '回款')
        AND primary_payment.status = sop.status
        AND primary_payment.paid_at IS NOT DISTINCT FROM sop.paid_at
      ORDER BY
        CASE WHEN primary_payment.change_type = '首次支付' THEN 0 ELSE 1 END,
        primary_payment.id
      LIMIT 1
    ) paired_payment ON true
  )
  SELECT id, sale_order_id, change_type, status,
         column_value::text AS column_value,
         legacy_value::text AS legacy_value
  FROM legacy
  WHERE column_value IS DISTINCT FROM legacy_value
  ORDER BY id
`

const NULL_SQL = `
  SELECT id, sale_order_id, change_type::text AS change_type, status::text AS status
  FROM sale_order_payments
  WHERE performance_attribution_date IS NULL
  ORDER BY id
`

const FIRST_PAYMENT_SQL = `
  SELECT p.id, p.sale_order_id,
         p.performance_attribution_date::text  AS payment_attribution_date,
         so.performance_attribution_date::text AS order_attribution_date
  FROM sale_order_payments p
  JOIN sale_orders so ON so.sale_order_id = p.sale_order_id
  WHERE p.change_type = '首次支付'
    AND p.performance_attribution_date IS DISTINCT FROM so.performance_attribution_date
  ORDER BY p.id
`

async function runCheck(db, label, sql) {
  const { rows } = await db.query(sql)
  if (rows.length === 0) {
    log(`✅ ${label}：0 行`)
    return 0
  }
  log(`❌ ${label}：${rows.length} 行`)
  console.table(rows.slice(0, SAMPLE_LIMIT))
  if (rows.length > SAMPLE_LIMIT) {
    log(`   （只列出前 ${SAMPLE_LIMIT} 行）`)
  }
  return rows.length
}

async function main() {
  if (!CONNECTION_STRING) {
    console.error('必须显式传 DATABASE_URL —— 三套业务库同端口同库名，只靠 IP 区分，不设默认值。')
    process.exit(2)
  }

  const host = new URL(CONNECTION_STRING).hostname
  log(`目标库 ${host}（${KNOWN_HOSTS[host] || '未登记的 host，确认没连错再看结论'}）`)

  // 三项必须在**同一个 REPEATABLE READ 只读事务**里：业务库 7×24 在写，
  // 分别用三个连接各取一次快照的话，下面 `d1 - d3` 推导卡行漂移数会得出负数或漏判。
  const client = new Client({ connectionString: CONNECTION_STRING })
  await client.connect()
  try {
    await client.query('BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY')
    const total = (await client.query('SELECT COUNT(*)::bigint AS n FROM sale_order_payments')).rows[0].n
    log(`sale_order_payments 共 ${total} 行（同一快照）`)

    const d1 = await runCheck(client, 'D1 直读列 = 旧 CASE 表达式', DRIFT_SQL)
    const d2 = await runCheck(client, 'D2 归属日期列无 NULL', NULL_SQL)
    const d3 = await runCheck(client, 'D3 首次支付行 = 订单级归属日期（I6）', FIRST_PAYMENT_SQL)

    log('')
    if (d1 === 0 && d2 === 0 && d3 === 0) {
      log('三项全清，可以执行迁移 0040。')
      process.exitCode = 0
      return
    }
    // 三项不是同一种严重程度，别一律当成阻塞：
    if (d3 > 0) {
      log(`D3 的 ${d3} 行会被迁移 0040 的 ① 回填自动拉齐 —— **预期内，不阻塞**。`)
      log('  （D1 里由首次支付脱拍带来的那部分同理，回填之后 ② 自检看到的就是 0 行。）')
    }
    if (d2 > 0) {
      log(`⛔ D2 的 ${d2} 行是真阻塞：0040 的 CHECK 约束会直接失败。`)
      log('  多半是这个库还没 apply 0039 —— 按 journal 顺序把 0039 补上即可（它的回填②会填掉这些 NULL）。')
      log('  ⚠ 有 NULL 时 D1 的结论不可用：NULL 行同时命中 D1 与 D2，无法从 D1 分解出真正的卡行漂移。')
      log('     先 apply 0039，再重跑本脚本，那时 D1 的读数才有意义。')
      process.exitCode = 1
      return
    }
    // 只有在 D2=0（列已无 NULL）时，才能把 D1 拆成「首次支付脱拍」与「其余」两部分
    const cardDrift = d1 - d3
    if (cardDrift > 0) {
      log(`⛔ D1 里有 ${cardDrift} 行不属于首次支付脱拍（多半是储值卡抵扣）：① 回填不覆盖这类，`)
      log('  ② 自检会 RAISE 回滚整条迁移。必须人工判读上面的样例后再决定补回填还是改口径。')
    }
    process.exitCode = cardDrift > 0 ? 1 : 0
  } finally {
    await client.query('ROLLBACK').catch(() => {})
    await client.end()
  }
}

main().catch((err) => {
  console.error('[ATTR-DRIFT] 执行失败：', err.message)
  process.exit(2)
})
