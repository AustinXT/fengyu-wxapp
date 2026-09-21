#!/usr/bin/env node
/**
 * 发布预检（只读）：目标库落后多少个迁移、待应用清单、关键不变量现值、硬约束提醒。
 *
 * 起因：2026-09-21 补验收时发现 prod 库停在 0040，而 dev 已到 0047 ——
 * #137/#138/#139/#140/#141 的口径收敛、#154 的拆列、#183 的导出列**在生产上全都没生效**，
 * 而这件事在任何地方都看不出来（admin 页面正常、资金不变量也正常，因为旧代码配旧库是自洽的）。
 * 这个脚本就是把"到底发没发"变成一条命令。
 *
 * ⚠ 只读：不迁移、不写库、不部署。
 *
 * 用法：
 *   DATABASE_URL="postgresql://.../fengyu_wxapp" node db/scripts/preflight-release.js
 *   # prod 建议用只读账号 fengyu_ro
 */
const fs = require('node:fs')
const path = require('node:path')
const { Client } = require('pg')

const JOURNAL = path.resolve(__dirname, '..', 'migrations', 'meta', '_journal.json')

/** 需要人工确认的高风险迁移：tag → 风险说明 */
const RISKY = {
  '0046_split_quantity_semantics':
    '破坏性：picked_up_quantity 拆三列，不向前也不向后兼容。必须 db:migrate（单事务），' +
    '禁用 apply-pending-migrations.js；迁移前须冻结「家居退款审批」与「转换折抵」并等在途事务排空；' +
    '迁移后必须紧接着部署三端，且**禁止回滚代码**（旧代码会把已退/已转份额读回可提可退 → 资损）。' +
    '详见 docs/changes/arch/012。',
  '0041_bizarre_wolfpack':
    '视图改直读 + 加 CHECK 约束 + AFTER UPDATE trigger，并回填首次支付行归属日期。' +
    '须先迁库再部署：未迁库时新代码直读的列会缺值，三值逻辑会吞掉正数主体。',
  '0047_waived_amount_and_zero_qty_out': '随 0046 一同发布，含折抵退出行的固定预留口径。',
}

const log = (...a) => console.log(...a)

async function main() {
  const url = process.env.DATABASE_URL || process.env.PG_CONNECTION_STRING
  if (!url) throw new Error('需要 DATABASE_URL 或 PG_CONNECTION_STRING')
  const client = new Client({ connectionString: url })
  await client.connect()

  const { rows: [meta] } = await client.query(
    `SELECT current_database() AS db, COALESCE(inet_server_addr()::text,'local') AS host`,
  )
  log(`\n═══ 发布预检 ═══`)
  log(`目标库: ${meta.db} @ ${meta.host}`)

  // ── 1. 迁移差距 ──
  const journal = JSON.parse(fs.readFileSync(JOURNAL, 'utf8'))
  const { rows: applied } = await client.query(
    `SELECT created_at::text AS when_ms FROM drizzle.__drizzle_migrations ORDER BY created_at DESC LIMIT 1`,
  )
  if (applied.length === 0) {
    log('⚠ 目标库没有任何迁移记录（空库？）')
  }
  // drizzle 判「已应用」只比 when，不比 hash（drizzle-orm/pg-core/dialect.cjs）
  const lastWhen = applied.length ? BigInt(applied[0].when_ms) : 0n
  const pending = journal.entries.filter((e) => BigInt(e.when) > lastWhen)

  log(`\n── 迁移状态 ──`)
  log(`目标库最新 when: ${lastWhen}（${new Date(Number(lastWhen)).toISOString().slice(0, 10)}）`)
  log(`本地 journal 共 ${journal.entries.length} 条，待应用 ${pending.length} 条`)
  if (pending.length) {
    for (const e of pending) {
      const risk = RISKY[e.tag]
      log(`  • ${e.tag}`)
      if (risk) log(`      ⚠ ${risk}`)
    }
  } else {
    log('  ✅ 目标库已是最新')
  }

  // ── 2. 关键不变量现值 ──
  log(`\n── 关键不变量（迁移前基线，迁移后应复跑对比）──`)
  const checks = [
    ['I1 received = Σ已支付款项（豁免 workfine）', `
      SELECT count(*)::int AS n FROM (
        SELECT so.sale_order_id FROM sale_orders so
        LEFT JOIN sale_order_payments sop ON sop.sale_order_id=so.sale_order_id
          AND sop.status='已支付' AND sop.change_type IN ('首次支付','回款','储值卡抵扣')
        WHERE so.legacy_source IS DISTINCT FROM 'workfine'
        GROUP BY so.sale_order_id, so.received
        HAVING ABS(so.received::numeric - COALESCE(SUM(sop.amount::numeric),0)) > 0.01) t`],
    ['I2 refunded_amount = -Σ退款', `
      SELECT count(*)::int AS n FROM (
        SELECT so.sale_order_id FROM sale_orders so
        LEFT JOIN sale_order_payments sop ON sop.sale_order_id=so.sale_order_id
          AND sop.status='已支付' AND sop.change_type='退款'
        GROUP BY so.sale_order_id, so.refunded_amount
        HAVING ABS(so.refunded_amount::numeric - COALESCE(-SUM(sop.amount::numeric),0)) > 0.01) t`],
    ['I3 积分余额 = Σ未过期批次', `
      WITH s AS (SELECT user_id, COALESCE(SUM(remaining_amount),0)::bigint t
                   FROM point_batches WHERE remaining_amount>0 AND expire_at>NOW() GROUP BY user_id)
      SELECT count(*)::int AS n FROM client_wechat_users u LEFT JOIN s ON s.user_id=u.user_id
       WHERE COALESCE(u.points_balance,0) <> COALESCE(s.t,0)`],
    ['I4 储值卡余额 = Σ卡流水', `
      SELECT count(*)::int AS n FROM (
        SELECT pc.card_id FROM prepaid_cards pc
        LEFT JOIN card_transactions ct ON ct.card_id=pc.card_id
        GROUP BY pc.card_id, pc.balance
        HAVING ABS(pc.balance::numeric - COALESCE(SUM(ct.amount::numeric),0)) > 0.01) t`],
    ['I6 首次支付归属日 = 订单归属日', `
      SELECT count(*)::int AS n FROM sale_order_payments p
       JOIN sale_orders so ON so.sale_order_id=p.sale_order_id
       WHERE p.change_type='首次支付'
         AND p.performance_attribution_date IS DISTINCT FROM so.performance_attribution_date`],
  ]
  for (const [name, q] of checks) {
    try {
      const { rows: [r] } = await client.query(q)
      log(`  ${r.n === 0 ? '✅' : '⚠ '} ${name}: ${r.n} 条违规`)
    } catch (e) {
      log(`  ✗ ${name}: 查询失败 —— ${e.message}`)
    }
  }
  log(`  提示：I6 的存量由 0041 的「① 回填首次支付行」自动拉齐，无需额外脚本；`)
  log(`        I3 的缺口来自到店积分未建批次，须跑 db/scripts/backfill-visit-points-batches.js（先 dry-run）。`)

  // ── 3. 库侧对象是否到位 ──
  log(`\n── 口径收敛对象（0041 交付物）──`)
  const objects = [
    ['视图直读（无 paired_payment 残留）', `
      SELECT CASE WHEN position('paired_payment' in pg_get_viewdef('sale_item_performance_events'::regclass, true))=0
                  THEN 1 ELSE 0 END AS ok`],
    ['trigger trg_sale_orders_sync_payment_attribution', `
      SELECT count(*)::int AS ok FROM pg_trigger
       WHERE tgrelid='sale_orders'::regclass AND NOT tgisinternal
         AND tgname='trg_sale_orders_sync_payment_attribution'`],
    ['CHECK chk_sop_attribution_date_present', `
      SELECT count(*)::int AS ok FROM pg_constraint
       WHERE conrelid='sale_order_payments'::regclass AND conname='chk_sop_attribution_date_present'`],
    ['sale_items 拆列（converted_quantity，0046 交付物）', `
      SELECT count(*)::int AS ok FROM information_schema.columns
       WHERE table_name='sale_items' AND column_name='converted_quantity'`],
  ]
  for (const [name, q] of objects) {
    try {
      const { rows: [r] } = await client.query(q)
      log(`  ${Number(r.ok) > 0 ? '✅' : '❌'} ${name}`)
    } catch (e) {
      log(`  ✗ ${name}: ${e.message}`)
    }
  }

  await client.end()

  // ── 4. 硬约束提醒 ──
  if (pending.length) {
    log(`\n── 执行顺序（硬约束，出自 docs/changes/arch/012）──`)
    log(`  ① 冻结写入：家居退款审批 + 转换折抵两个入口，等在途事务排空`)
    log(`  ② DATABASE_URL=<目标库> node db/scripts/verify-quantity-split.js   # 迁移前基线`)
    log(`  ③ TARGET_DATABASE_URL=<目标库> npm --prefix db run db:migrate       # 禁用 apply-pending-migrations.js`)
    log(`  ④ 紧接着部署三端（不可只部分）：`)
    log(`       scripts/deploy-cloudfunctions.sh prod`)
    log(`       .claude/skills/remote-deploy/deploy-admin.sh prod`)
    log(`  ⑤ 部署后复跑本脚本 + verify-quantity-split.js，确认 I1/I2/I6 与拆列断言全绿`)
    log(`  ⑥ 恢复写入`)
    log(`  ⚠ 禁止回滚代码：新列写过之后回滚，旧代码会把已退/已转份额读回可提可退（资损），只能 forward-fix。`)
  }
  log('')
}

main().catch((e) => {
  console.error('[preflight-release] 失败:', e.message)
  process.exit(1)
})
