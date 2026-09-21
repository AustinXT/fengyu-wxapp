#!/usr/bin/env node
'use strict'

/**
 * verify-quantity-split.js — #154 数量拆列的**只读**核对脚本（迁移 0046 配套）。
 *
 * 本脚本从不写库。它同时承担迁移前的 dry-run 预演与迁移后的守恒校验，
 * 按 sale_items 上是否已存在 refunded_quantity / converted_quantity 自动切换模式。
 *
 * ── 迁移前（列尚不存在）────────────────────────────────────────────────
 *   预演 0046 的回填口径，逐行给出 before/after。**阻断项**（退出码 1）只有两类，
 *   都是迁移会 RAISE EXCEPTION 的情形：
 *     · residual < 0                       —— 物理提货 + 已转换 超过旧的已结算合计
 *     · residual > 0、无退款、但有提货记录  —— 无从解释的结算量
 *   另有两类只做提示不阻断：「历史提货未留记录」的残差、部署窗口暴露面。
 *   另外算出**部署窗口暴露面**：0046 不向前兼容，迁移已跑而新代码未部署的那段时间里，
 *   旧代码把 picked_up_quantity 读成「已结算」，被拆走的退款/折抵份额会短暂回到可提。
 *   整单退款的订单被派生查询的状态白名单挡住（o.status IN ('已支付','部分支付','已完成')），
 *   **部分退款**的订单不受保护 —— 这里统计的就是后者。
 *
 * ── 迁移后（列已存在）──────────────────────────────────────────────────
 *     · AC4 不变量：有提货记录的行，picked_up_quantity == SUM(pickup_records.pickup_quantity)
 *     · 三列非负，且合计不超过 quantity —— 后者已由 0046 的 CHECK 约束
 *       chk_sale_item_settled_le_quantity 保证，这里是约束被误 DROP 时的二道保险
 *
 * 任一异常 → 退出码 1，可直接挂在部署脚本前后。
 *
 * 用法（DATABASE_URL 必填且必须精确指向业务库，无默认值）：
 *   DATABASE_URL="postgresql://...@101.34.242.103:5433/fengyu_wxapp" \
 *     node db/scripts/verify-quantity-split.js
 *   加 --verbose 打印逐行明细（默认只给汇总 + 前 20 条样例）
 */

const { Client } = require('pg')

// DATABASE_URL 必填且必须精确指向业务库（db/CLAUDE.md 硬规则：显式传值 + 断言 host/port/dbname）。
// 实现见 _lib/assert-db-target.js —— 它同时挡住 `?host=` 与 `?%68ost=`（百分号编码）两层 query 覆盖绕过。
// 仅在直接执行时校验——本目录部分脚本的导出函数被 __tests__ require，顶层 exit 会打断测试进程。
const { assertDbTargetOrExit } = require('./_lib/assert-db-target')
if (require.main === module) assertDbTargetOrExit(process.env.DATABASE_URL)

const VERBOSE = process.argv.includes('--verbose')
const SAMPLE = 20

/** 三语义的两个独立数据源；与迁移 0046 和四端派生口径字面同源。 */
const PICKED_PHYS = `COALESCE((
  SELECT SUM(pr.pickup_quantity)::int FROM pickup_records pr
   WHERE pr.sale_item_id = si.sale_item_id
), 0)`

const CONVERTED = `COALESCE((
  SELECT SUM(out_item.quantity)::int
    FROM sale_items out_item
    JOIN sale_orders conv_order ON conv_order.sale_order_id = out_item.sale_order_id
   WHERE out_item.ref_sale_item_id = si.sale_item_id
     AND out_item.item_direction = '转出'
     AND out_item.product_type = '家居产品'
     AND conv_order.status <> '已关闭'
), 0)`

/**
 * 「本行退款实据」—— 与迁移 0046 的前置断言字面同口径。
 * 只看「订单上有没有退款」会把同单**他行**的退款错安到本行头上（双谱系评审命中）：
 * 「已消耗」口径刻意不含 refunded，错记会让 overpay 余数虚高 → 多退。
 */
const HAS_ITEM_REFUND_EVIDENCE = `(
  o.status = '已退款'
  OR EXISTS (
    SELECT 1 FROM sale_order_payments sop
     WHERE sop.sale_order_id = si.sale_order_id
       AND sop.change_type = '退款'
       AND sop.status = '已支付'
       AND sop.ref_sale_item_id = si.sale_item_id
  )
  OR EXISTS (
    SELECT 1
      FROM sale_order_payments sop
      CROSS JOIN LATERAL jsonb_array_elements(
        -- ⚠ 与全仓 note→jsonb 守门写法字面一致（四端 14 处同款，由 cross-end-sql-snapshot
        -- 的「四端 note→jsonb 守门」一项守护）。评审建议过改 btrim 兜住前导空格，不采纳：
        -- 那会让这里单独偏离四端约定，而实测 prod 235 条退款 note 全合法、0 条带前导空格。
        CASE WHEN sop.note LIKE '{%'
             THEN CASE WHEN jsonb_typeof((sop.note)::jsonb -> 'items') = 'array'
                       THEN (sop.note)::jsonb -> 'items'
                       ELSE '[]'::jsonb END
             ELSE '[]'::jsonb END
      ) AS elem
     WHERE sop.sale_order_id = si.sale_order_id
       AND sop.change_type = '退款'
       AND sop.status = '已支付'
       AND elem ->> 'refSaleItemId' = si.sale_item_id
  )
)`

async function columnsExist(client) {
  const { rows } = await client.query(
    `SELECT COUNT(*)::int AS n
       FROM information_schema.columns
      WHERE table_name = 'sale_items'
        AND column_name IN ('refunded_quantity', 'converted_quantity')`,
  )
  return rows[0].n === 2
}

function report(title, rows) {
  const sample = SAMPLE
  console.log(`\n## ${title}：${rows.length} 行`)
  if (rows.length === 0) return
  console.table(VERBOSE ? rows : rows.slice(0, sample))
  if (!VERBOSE && rows.length > sample) {
    console.log(`   …另有 ${rows.length - sample} 行，加 --verbose 看全部`)
  }
}

/** 迁移前：预演回填 + 算部署窗口暴露面。 */
async function dryRun(client) {
  console.log('模式：**迁移前 dry-run**（sale_items 尚无 refunded_quantity / converted_quantity）\n')
  let problems = 0

  const { rows: plan } = await client.query(`
    WITH src AS (
      SELECT si.sale_item_id,
             si.sale_order_id,
             si.quantity,
             COALESCE(si.picked_up_quantity, 0) AS old_settled,
             ${PICKED_PHYS} AS picked_phys,
             ${CONVERTED} AS conv,
             ${HAS_ITEM_REFUND_EVIDENCE} AS has_item_refund_evidence
        FROM sale_items si
        JOIN sale_orders o ON o.sale_order_id = si.sale_order_id
       -- ⚠ 这三个分支必须与迁移 0046 的 WHERE **字面同口径**：少一个分支，dry-run 会对
       -- 「picked_up=0 但有未关闭转出行」这类历史行报「全部通过」，而迁移实际会 RAISE 回滚。
       WHERE COALESCE(si.picked_up_quantity, 0) <> 0
          OR EXISTS (SELECT 1 FROM pickup_records pr WHERE pr.sale_item_id = si.sale_item_id)
          OR EXISTS (
               SELECT 1
                 FROM sale_items out_item
                 JOIN sale_orders conv_order ON conv_order.sale_order_id = out_item.sale_order_id
                WHERE out_item.ref_sale_item_id = si.sale_item_id
                  AND out_item.item_direction = '转出'
                  AND out_item.product_type = '家居产品'
                  AND conv_order.status <> '已关闭'
             )
    )
    SELECT *, old_settled - picked_phys - conv AS residual
      FROM src
     ORDER BY sale_item_id
  `)

  const toRow = (r) => ({
    sale_item_id: r.sale_item_id,
    quantity: r.quantity,
    旧_已结算: r.old_settled,
    新_已提货: r.picked_phys,
    新_已退款: Math.max(0, r.residual),
    新_已转换: r.conv,
  })

  report('待回填行（预演 before/after）', plan.map(toRow))

  const negative = plan.filter((r) => r.residual < 0)
  if (negative.length > 0) {
    problems += negative.length
    console.log('\n✗ residual < 0：物理提货 + 已转换 已超过旧的已结算合计。')
    console.log('  迁移 0046 的前置断言会 RAISE EXCEPTION 回滚整个迁移，必须先查清这些行。')
    report('residual < 0 明细', negative.map(toRow))
  }

  // 与迁移 0046 的前置断言同口径：残差必须能落到**本行**的退款实据上，否则拦下。
  // 初版留过一条「无退款残差视为历史提货未留记录」的口子，它让 AC4 不再是全量不变量、
  // 并迫使 cron C5 为这类行开永久盲区（双谱系评审命中）。现在一律阻断。
  const unexplained = plan.filter((r) => r.residual > 0 && !r.has_item_refund_evidence)
  if (unexplained.length > 0) {
    problems += unexplained.length
    console.log('\n✗ 残差查无本行退款实据 → 迁移 0046 会 RAISE EXCEPTION 中止。')
    console.log('  实据三选一：整单已退款 / 退款流水 ref_sale_item_id 指向本行 / 退款 note.items 含本行。')
    console.log('  典型来源：同单他行退款、已删除转换单的转出行。必须先查清。')
    report('无从解释的残差明细', unexplained.map(toRow))
  }

  // 部署窗口暴露面：迁移已跑、新代码未部署时，旧代码会把哪些份额重新放出来。
  // 整单退款（status='已退款'）被派生查询的状态白名单挡住，不计入；部分退款不受保护。
  const { rows: exposure } = await client.query(`
    SELECT si.sale_item_id, si.sale_order_id, o.status AS order_status,
           si.quantity, COALESCE(si.picked_up_quantity, 0) AS old_settled,
           si.received, si.unit_real_price
      FROM sale_items si
      JOIN sale_orders o ON o.sale_order_id = si.sale_order_id
     WHERE si.product_type = '家居产品'
       AND COALESCE(si.picked_up_quantity, 0) > 0
       AND o.status IN ('已支付', '部分支付', '已完成')
     ORDER BY si.sale_item_id
  `)
  if (exposure.length > 0) {
    // 刻意**不**计入 problems：这不是异常，而是任何有存量提货/退款数据的库的正常状态，
    // 且处置办法是「压缩部署窗口」——它缩短的是暴露**时间**，不会让这个行数变 0。
    // 计入 problems 会让 dry-run 在正常库上恒退出 1，挂在部署脚本前直接把部署卡死。
    console.log('\n⚠ 部署窗口暴露面不为 0：以下行的订单仍在展示状态白名单内，')
    console.log('  迁移后到三端部署完成之间，被拆走的份额会短暂回到可提/可退。')
    console.log('  确认迁移与三端部署在同一个窗口内完成即可继续。')
    report('暴露行明细', exposure)
  } else {
    console.log('\n✓ 部署窗口暴露面为 0（picked_up_quantity > 0 的家居行都不在展示状态白名单内）')
  }

  return problems
}

/** 迁移后：AC4 不变量 + 三列合法性。 */
async function verifyAfter(client) {
  console.log('模式：**迁移后守恒校验**（sale_items 已有 refunded_quantity / converted_quantity）\n')
  let problems = 0

  // 与迁移事后断言、cron C5 同构，且是**全量**比对：
  // 用 INNER JOIN 会把「有 picked_up 但零 pickup_records」的损坏行整片漏掉 ——
  // 而那正是「删提货记录」出错后的形态。
  const { rows: mismatch } = await client.query(`
    SELECT COALESCE(si.sale_item_id, p.sale_item_id) AS sale_item_id,
           COALESCE(si.picked_up_quantity, 0) AS picked_up_quantity,
           COALESCE(p.pickup_records_total, 0) AS pickup_records_total
      FROM sale_items si
      FULL JOIN (
             SELECT sale_item_id, SUM(pickup_quantity)::int AS pickup_records_total
               FROM pickup_records
              GROUP BY sale_item_id
           ) p ON p.sale_item_id = si.sale_item_id
     WHERE COALESCE(si.picked_up_quantity, 0) <> COALESCE(p.pickup_records_total, 0)
     ORDER BY 1
  `)
  if (mismatch.length > 0) {
    problems += mismatch.length
    console.log('✗ AC4 不变量被破坏：picked_up_quantity ≠ SUM(pickup_records.pickup_quantity)')
    report('不一致明细', mismatch)
  } else {
    console.log('✓ AC4 不变量成立：有提货记录的行 picked_up_quantity == SUM(pickup_records)')
  }

  // 与 cron C5c 同构：converted_quantity 是三列里唯一有独立交叉源的（转出行即折抵凭证）。
  // 不在部署后当场校验，就只能等日频 cron 才发现旧实例误写或回退漏跑。
  const { rows: convMismatch } = await client.query(`
    SELECT COALESCE(si.sale_item_id, o.ref_sale_item_id) AS sale_item_id,
           COALESCE(si.converted_quantity, 0) AS converted_quantity,
           COALESCE(o.total_converted, 0) AS out_rows_total
      FROM sale_items si
      FULL JOIN (
             SELECT out_item.ref_sale_item_id, SUM(out_item.quantity)::int AS total_converted
               FROM sale_items out_item
               JOIN sale_orders conv_order ON conv_order.sale_order_id = out_item.sale_order_id
              WHERE out_item.item_direction = '转出'
                AND out_item.product_type = '家居产品'
                AND out_item.ref_sale_item_id IS NOT NULL
                AND conv_order.status <> '已关闭'
              GROUP BY out_item.ref_sale_item_id
           ) o ON o.ref_sale_item_id = si.sale_item_id
     WHERE COALESCE(si.converted_quantity, 0) <> COALESCE(o.total_converted, 0)
     ORDER BY 1
  `)
  if (convMismatch.length > 0) {
    problems += convMismatch.length
    console.log('\n✗ converted_quantity 与未关闭转出行聚合不一致')
    report('不一致明细', convMismatch)
  } else {
    console.log('✓ converted_quantity 与未关闭转出行聚合守恒')
  }

  const { rows: bad } = await client.query(`
    SELECT sale_item_id, quantity,
           COALESCE(picked_up_quantity, 0) AS picked_up_quantity,
           COALESCE(refunded_quantity, 0) AS refunded_quantity,
           COALESCE(converted_quantity, 0) AS converted_quantity
      FROM sale_items
     WHERE COALESCE(picked_up_quantity, 0) < 0
        OR COALESCE(refunded_quantity, 0) < 0
        OR COALESCE(converted_quantity, 0) < 0
        OR COALESCE(picked_up_quantity, 0) + COALESCE(refunded_quantity, 0)
           + COALESCE(converted_quantity, 0) > quantity
     ORDER BY sale_item_id
  `)
  if (bad.length > 0) {
    problems += bad.length
    console.log('\n✗ 三列非法：出现负值，或「已结算」合计超过购买件数')
    console.log('  后者本应被 0046 的 CHECK 约束 chk_sale_item_settled_le_quantity 挡住 —— ')
    console.log('  真的报出来说明约束被 DROP 了，先查约束是否还在。')
    report('非法明细', bad)
  } else {
    console.log('✓ 三列均非负，且合计不超过 quantity')
  }

  return problems
}

async function main() {
  const client = new Client({ connectionString: process.env.DATABASE_URL.trim() })
  await client.connect()
  try {
    const { rows: who } = await client.query(
      `SELECT current_database() AS db, COALESCE(host(inet_server_addr()), 'local') AS addr`,
    )
    console.log(`# #154 数量拆列核对 — ${who[0].db} @ ${who[0].addr}`)

    const problems = (await columnsExist(client)) ? await verifyAfter(client) : await dryRun(client)

    if (problems > 0) {
      console.error(`\n✗ 共 ${problems} 项需要处理`)
      process.exitCode = 1
    } else {
      console.log('\n✓ 全部检查通过')
    }
  } finally {
    await client.end()
  }
}

if (require.main === module) {
  main().catch((err) => {
    console.error(err)
    process.exit(1)
  })
}

