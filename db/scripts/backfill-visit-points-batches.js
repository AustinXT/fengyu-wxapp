#!/usr/bin/env node
/**
 * 到店赠送积分补建 point_batches（I3 不变量修复）
 *
 * 背景：三端 `visit-points`（staffApi / clientApi / admin lib）发放到店积分时只
 * `INSERT point_transactions` + `UPDATE client_wechat_users.points_balance`，
 * **从不建 point_batches**；而消费赠送路径（staffApi utils/points.js 的 grantPointBatch、
 * admin points-settle.ts）都建。后果三条：
 *
 *   1. cron STEP「资金不变量 I3」（points_balance = Σ 未过期批次 remaining）永久违规，
 *      每天刷告警（prod operation_logs 里 points.balanceMismatch 已累计上万条）。
 *   2. **到店积分事实上永不过期** —— 过期处理（cron process-points-expiry）只扫 batch，
 *      扫不到它们，与「积分 365 天有效」（issue #67）的口径相悖。
 *   3. 抵扣时 `consumePointBatches` 尽力扣、扣不够也不报错，而余额校验看的是
 *      `points_balance` —— 所以**顾客不吃亏**（余额能用满），但账本长期不平。
 *      真正的风险在将来：若把余额改成由 batch 汇总，这部分会凭空消失。
 *
 * 本脚本只补历史数据。**代码侧必须同时修**（三端 visit-points 补 grantPointBatch），
 * 否则跑完当天又会产生新的无批次流水。
 *
 * 口径：
 *   - 只处理 `type='到店赠送'` 且没有任何 point_batches 指向它的正向流水
 *   - `original_amount` = 流水 amount；`earned_at` = 流水 created_at；
 *     `expire_at` = created_at + 365 天（与 grantPointBatch 逐字同口径）
 *   - `remaining_amount` 按用户维度分配：该用户的缺口 D = points_balance − Σ(现有未过期批次
 *     remaining)，按流水 **created_at 倒序**（新的先保留）依次填满，合计恰好 = D。
 *     依据是 `consumePointBatches` 按 expire_at 升序消费（= 先消费最早的），所以历史上
 *     被消费掉的应当是旧的那几笔。
 *   - D ≤ 0 的用户跳过（不平的方向相反，属另一类问题，见
 *     notes/memory 的「到店积分冲销漏扣批次」）
 *
 * ⚠ 默认 **dry-run**，只打印不写库；要真的写必须显式加 `--apply`。
 *
 * 用法：
 *   node db/scripts/backfill-visit-points-batches.js                 # 预览（默认）
 *   node db/scripts/backfill-visit-points-batches.js --apply         # 实际写入
 *   DATABASE_URL=... node db/scripts/backfill-visit-points-batches.js --limit 50
 */
const { Client } = require('pg')

const apply = process.argv.includes('--apply')
const limitArg = process.argv.indexOf('--limit')
const limit = limitArg > -1 ? Number(process.argv[limitArg + 1]) : null

const log = (...a) => console.log('[BACKFILL-VISIT-POINTS-BATCHES]', ...a)

async function main() {
  const url = process.env.DATABASE_URL || process.env.PG_CONNECTION_STRING
  if (!url) throw new Error('需要 DATABASE_URL 或 PG_CONNECTION_STRING')
  const client = new Client({ connectionString: url })
  await client.connect()

  const { rows: [{ db, host }] } = await client.query(
    `SELECT current_database() AS db, COALESCE(inet_server_addr()::text,'local') AS host`,
  )
  log(`库: ${db} @ ${host}`)
  log(`模式: ${apply ? 'APPLY（实际写入）' : 'DRY-RUN（仅预览，不写入）'}`)

  // 1. 受影响用户的缺口 D
  const { rows: gaps } = await client.query(`
    WITH batch_sums AS (
      SELECT user_id, COALESCE(SUM(remaining_amount), 0)::bigint AS batch_total
        FROM point_batches
       WHERE remaining_amount > 0 AND expire_at > NOW()
       GROUP BY user_id
    )
    SELECT u.user_id,
           COALESCE(u.points_balance, 0)::bigint                       AS balance,
           COALESCE(b.batch_total, 0)::bigint                          AS batch_total,
           (COALESCE(u.points_balance,0) - COALESCE(b.batch_total,0))::bigint AS gap
      FROM client_wechat_users u
      LEFT JOIN batch_sums b ON b.user_id = u.user_id
     WHERE COALESCE(u.points_balance, 0) > COALESCE(b.batch_total, 0)
     ORDER BY gap DESC
     ${limit ? `LIMIT ${Number(limit)}` : ''}
  `)
  log(`缺口用户: ${gaps.length} 户，合计 ${gaps.reduce((s, r) => s + Number(r.gap), 0)} 分`)

  let planned = 0
  let plannedPoints = 0
  const unresolved = []

  for (const g of gaps) {
    // 2. 该用户所有「无批次」的到店赠送流水，新 → 旧
    const { rows: txns } = await client.query(
      `SELECT pt.id, pt.amount::bigint AS amount, pt.created_at
         FROM point_transactions pt
         LEFT JOIN point_batches pb ON pb.source_transaction_id = pt.id
        WHERE pt.user_id = $1 AND pt.amount > 0 AND pt.type = '到店赠送' AND pb.id IS NULL
        ORDER BY pt.created_at DESC, pt.id DESC`,
      [g.user_id],
    )
    if (txns.length === 0) {
      unresolved.push({ userId: g.user_id, gap: Number(g.gap), reason: '缺口非到店积分所致' })
      continue
    }

    let left = Number(g.gap)
    const plan = []
    for (const t of txns) {
      const keep = Math.max(0, Math.min(Number(t.amount), left))
      left -= keep
      plan.push({ txnId: t.id, original: Number(t.amount), remaining: keep })
    }
    if (left > 0) {
      unresolved.push({ userId: g.user_id, gap: Number(g.gap), reason: `到店流水不足以覆盖缺口，差 ${left}` })
    }

    for (const p of plan) {
      planned += 1
      plannedPoints += p.remaining
      if (apply) {
        await client.query(
          `INSERT INTO point_batches (
             user_id, source_transaction_id, source_type, ref_order_id,
             original_amount, remaining_amount, earned_at, expire_at, created_at, updated_at
           )
           SELECT $1, $2, '到店赠送', pt.ref_order_id,
                  $3, $4, pt.created_at, pt.created_at + INTERVAL '365 days', NOW(), NOW()
             FROM point_transactions pt
            WHERE pt.id = $2`,
          [g.user_id, p.txnId, p.original, p.remaining],
        )
      }
    }
  }

  log(`拟补建批次: ${planned} 行，其中保留余额合计 ${plannedPoints} 分`)
  if (unresolved.length) {
    log(`⚠ 未能完全覆盖的用户 ${unresolved.length} 户（需人工判读）：`)
    unresolved.slice(0, 20).forEach((u) => log(`   ${u.userId} gap=${u.gap} — ${u.reason}`))
  }

  // 3. 写入后自检：I3 应归零
  if (apply) {
    const { rows: [chk] } = await client.query(`
      WITH batch_sums AS (
        SELECT user_id, COALESCE(SUM(remaining_amount), 0)::bigint AS t
          FROM point_batches WHERE remaining_amount > 0 AND expire_at > NOW() GROUP BY user_id
      )
      SELECT count(*)::int AS violations
        FROM client_wechat_users u
        LEFT JOIN batch_sums b ON b.user_id = u.user_id
       WHERE COALESCE(u.points_balance, 0) <> COALESCE(b.t, 0)
    `)
    log(`自检：I3 剩余违规 ${chk.violations} 户${chk.violations === 0 ? ' ✅' : ' ⚠ 需复查'}`)
  } else {
    log('dry-run 结束，未写入任何数据。确认无误后加 --apply 重跑。')
  }

  await client.end()
}

main().catch((e) => {
  console.error('[BACKFILL-VISIT-POINTS-BATCHES] 失败:', e.message)
  process.exit(1)
})
