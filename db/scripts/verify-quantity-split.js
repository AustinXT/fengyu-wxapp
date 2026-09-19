#!/usr/bin/env node
'use strict'

/**
 * verify-quantity-split.js — #154 数量拆列的**只读**核对脚本（迁移 0043 配套）。
 *
 * 本脚本从不写库。它同时承担迁移前的 dry-run 预演与迁移后的守恒校验，
 * 按 sale_items 上是否已存在 refunded_quantity / converted_quantity 自动切换模式。
 *
 * ── 迁移前（列尚不存在）────────────────────────────────────────────────
 *   预演 0043 的回填口径，逐行给出 before/after。**阻断项**（退出码 1）只有两类，
 *   都是迁移会 RAISE EXCEPTION 的情形：
 *     · residual < 0                       —— 物理提货 + 已转换 超过旧的已结算合计
 *     · residual > 0、无退款、但有提货记录  —— 无从解释的结算量
 *   另有两类只做提示不阻断：「历史提货未留记录」的残差、部署窗口暴露面。
 *   另外算出**部署窗口暴露面**：0043 不向前兼容，迁移已跑而新代码未部署的那段时间里，
 *   旧代码把 picked_up_quantity 读成「已结算」，被拆走的退款/折抵份额会短暂回到可提。
 *   整单退款的订单被派生查询的状态白名单挡住（o.status IN ('已支付','部分支付','已完成')），
 *   **部分退款**的订单不受保护 —— 这里统计的就是后者。
 *
 * ── 迁移后（列已存在）──────────────────────────────────────────────────
 *     · AC4 不变量：有提货记录的行，picked_up_quantity == SUM(pickup_records.pickup_quantity)
 *     · 三列非负，且合计不超过 quantity —— 后者已由 0043 的 CHECK 约束
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

/** 三语义的两个独立数据源；与迁移 0043 和四端派生口径字面同源。 */
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

const HAS_PAID_REFUND = `EXISTS (
  SELECT 1 FROM sale_order_payments sop
   WHERE sop.sale_order_id = si.sale_order_id
     AND sop.change_type = '退款'
     AND sop.status = '已支付'
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
             ${HAS_PAID_REFUND} AS has_paid_refund,
             EXISTS (
               SELECT 1 FROM pickup_records pr WHERE pr.sale_item_id = si.sale_item_id
             ) AS has_pickup_records
        FROM sale_items si
       -- ⚠ 这三个分支必须与迁移 0043 的 WHERE **字面同口径**：少一个分支，dry-run 会对
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
    新_已提货: r.picked_phys
      + (r.residual > 0 && !r.has_paid_refund && !r.has_pickup_records ? r.residual : 0),
    新_已退款: r.residual > 0 && r.has_paid_refund ? r.residual : 0,
    新_已转换: r.conv,
  })

  report('待回填行（预演 before/after）', plan.map(toRow))

  const negative = plan.filter((r) => r.residual < 0)
  if (negative.length > 0) {
    problems += negative.length
    console.log('\n✗ residual < 0：物理提货 + 已转换 已超过旧的已结算合计。')
    console.log('  迁移 0043 的前置断言会 RAISE EXCEPTION 回滚整个迁移，必须先查清这些行。')
    report('residual < 0 明细', negative.map(toRow))
  }

  // 有提货记录却仍有无退款实据的残差：并回 picked_up 会破坏「picked_up == SUM(pickup_records)」，
  // 并回 refunded 又查无实据 —— 迁移 0043 的前置断言会 RAISE 把整条迁移打回。
  const unexplained = plan.filter((r) => r.residual > 0 && !r.has_paid_refund && r.has_pickup_records)
  if (unexplained.length > 0) {
    problems += unexplained.length
    console.log('\n✗ 有提货记录、却存在无退款实据的残差 → 迁移 0043 会 RAISE EXCEPTION 中止。')
    console.log('  典型来源：已删除转换单的转出行（conv 聚合归 0 而 picked_up 仍被抬高）。必须先查清。')
    report('无从解释的残差明细', unexplained.map(toRow))
  }

  const legacyPicked = plan.filter((r) => r.residual > 0 && !r.has_paid_refund && !r.has_pickup_records)
  if (legacyPicked.length > 0) {
    console.log('\n⚠ 有残差、订单无已支付退款、且完全没有 pickup_records → 按口径视为「历史提货未留记录」，')
    console.log('  会留在 picked_up_quantity。不阻断迁移，但请人工确认这批数据的来历。')
    console.log('  注意：cron STEP 12 的 C5 对这类行同样豁免（判据带 EXISTS(pickup_records)）。')
    report('历史提货残差明细', legacyPicked.map(toRow))
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

  // 与迁移事后断言 2、cron C5 同构：由 pickup_records 聚合驱动，
  // 「无提货记录的行豁免」由 JOIN 天然表达，也避免同一相关子查询被求值两遍。
  const { rows: mismatch } = await client.query(`
    SELECT si.sale_item_id,
           COALESCE(si.picked_up_quantity, 0) AS picked_up_quantity,
           p.pickup_records_total
      FROM (
             SELECT sale_item_id, SUM(pickup_quantity)::int AS pickup_records_total
               FROM pickup_records
              GROUP BY sale_item_id
           ) p
      JOIN sale_items si ON si.sale_item_id = p.sale_item_id
     WHERE COALESCE(si.picked_up_quantity, 0) <> p.pickup_records_total
     ORDER BY si.sale_item_id
  `)
  if (mismatch.length > 0) {
    problems += mismatch.length
    console.log('✗ AC4 不变量被破坏：picked_up_quantity ≠ SUM(pickup_records.pickup_quantity)')
    report('不一致明细', mismatch)
  } else {
    console.log('✓ AC4 不变量成立：有提货记录的行 picked_up_quantity == SUM(pickup_records)')
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
    console.log('  后者本应被 0043 的 CHECK 约束 chk_sale_item_settled_le_quantity 挡住 —— ')
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

