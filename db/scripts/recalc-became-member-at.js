#!/usr/bin/env node

/**
 * recalc-became-member-at.js — 一次性重算存量会员客的 became_member_at
 *
 * 背景：
 *   became_member_at 原口径 =「系统检测到首次跃迁为会员客的 NOW()」。对靠历史订单
 *   审核首次成为会员的客户，该值落在「审核操作当天」而非真实首单消费日（订单
 *   paid_at 已写成历史销售日，但 became_member_at 仍是 NOW()），导致会员报表的
 *   「本月新会员 / 历史会员数」按审核日计入、历史分布失真。
 *
 *   在线写入口径已改为「确立会员资格的首笔达标单时间」（COALESCE(paid_at, created_at)，
 *   staffApi/clientApi/payNotify/admin orders.ts/admin recompute-customer-tags 五端镜像）。
 *   本脚本对存量会员客做同样重算，使存量值 == 在线值。
 *
 * 选单口径（与在线 became_member_at 子查询逐字同源）：
 *   status IN ('已支付','已完成') AND sale_order_type='销售单' AND total_amount >= threshold
 *   ORDER BY paid_at ASC NULLS LAST, created_at ASC，每会员客取最早一单，取其
 *   COALESCE(paid_at, created_at)。不用 MIN(COALESCE)：MIN 在「某达标单 paid_at=NULL
 *   且 created_at 早于另一张达标单 paid_at」时会选不同的单，导致存量 ≠ 新单。
 *
 *   不带 `paid_at <= became_member_at` 守卫：本脚本是纯重算覆写（不是
 *   backfill-membership-upgrade-doc-type 的「选跃迁那一刻的单」语义），守卫会与
 *   旧 became_member_at 形成循环依赖。
 *
 * 幂等：UPDATE WHERE became_member_at IS DISTINCT FROM new_became，二次运行命中 0 行。
 *   不 bump updated_at（与在线五端 became_member_at UPDATE 对齐）。
 *
 * 边界：
 *   - 会员客但当前阈值无达标单（阈值历史上调过的存量会员）→ 不在 _target，保留原值
 *     不动（只由 ANOMALY 计数告警）。不可恢复（无阈值历史）。
 *   - paid_at 全 NULL 的达标单：COALESCE 回退 created_at（NOT NULL），new_became 恒非空。
 *
 * 用法：
 *   # dry-run（默认，仅打印统计 + 抽样）
 *   DATABASE_URL="postgresql://fengyu:fengyu123@47.113.202.7:5433/fengyu_wxapp" \
 *     node db/scripts/recalc-became-member-at.js
 *
 *   # 实际提交
 *   DATABASE_URL="postgresql://fengyu:fengyu123@47.113.202.7:5433/fengyu_wxapp" \
 *     node db/scripts/recalc-became-member-at.js --apply
 *
 * 顺序：先 dev（47.113.202.7:5433/fengyu_wxapp）--apply 验证；再 prod
 *   （118.178.196.26:5433/fengyu_wxapp）--apply。两库均 5433/fengyu_wxapp，仅 IP 区分。
 *   prod --apply 前先 `bash db/scripts/dump-prod.sh -t client_wechat_users` 备份（覆写不可逆）。
 *   e2e 绝不碰生产 IP 118.178.196.26。
 */

const { Pool } = require('pg')

const PG_CONFIG = {
  connectionString: process.env.DATABASE_URL || process.env.PG_CONNECTION_STRING,
  max: 3,
}

const apply = process.argv.includes('--apply')

function log(msg) {
  console.log(`[RECALC-BECAME-MEMBER-AT] ${new Date().toISOString()} ${msg}`)
}

// 阈值仅从 system_configs.new_member_threshold 读取；缺失或非法时 fail-fast。
const FETCH_THRESHOLD_SQL = `
SELECT value::numeric AS v
  FROM system_configs
 WHERE key = 'new_member_threshold'
 LIMIT 1
`

// 每个会员客取首笔达标单时间。DISTINCT ON + ORDER BY 与在线 became_member_at 子查询
// 同 WHERE/ORDER/投影 ⇒ 存量值 == 在线值。不带 paid_at<=became_member_at 守卫（纯重算覆写）。
// 不含回款单累计 LATERAL：refactor 后死代码；与 4 端在线有效口径一致。
const BUILD_TARGET_SQL = `
CREATE TEMP TABLE _target ON COMMIT DROP AS
SELECT DISTINCT ON (o.client_user_id)
       o.client_user_id AS user_id,
       COALESCE(o.paid_at, o.created_at) AS new_became,
       u.became_member_at AS old_became
  FROM sale_orders o
  JOIN client_wechat_users u ON u.user_id = o.client_user_id
 WHERE u.customer_type = '会员客'
   AND o.status IN ('已支付', '已完成')
   AND o.sale_order_type = '销售单'
   AND o.total_amount >= $1::numeric
 ORDER BY o.client_user_id, o.paid_at ASC NULLS LAST, o.created_at ASC
`

const PREVIEW_SQL = `
SELECT
  COUNT(*)::int                                                           AS target_users,
  SUM((old_became IS DISTINCT FROM new_became)::int)::int                 AS users_to_change,
  SUM((old_became IS NULL)::int)::int                                     AS users_pre_null,
  SUM((old_became IS NOT NULL AND new_became >  old_became)::int)::int    AS users_new_later,
  SUM((old_became IS NOT NULL AND new_became <  old_became)::int)::int    AS users_new_earlier
  FROM _target
`

const SAMPLE_SQL = `
SELECT user_id, old_became, new_became FROM _target
 WHERE old_became IS DISTINCT FROM new_became
 ORDER BY user_id
 LIMIT 20
`

// 幂等覆写；不 bump updated_at。
const UPDATE_SQL = `
UPDATE client_wechat_users u
   SET became_member_at = t.new_became
  FROM _target t
 WHERE u.user_id = t.user_id
   AND u.became_member_at IS DISTINCT FROM t.new_became
`

// 会员客但当前阈值无达标单（阈值历史上调过的存量会员）→ 保留原值不动。
// 另报两个数据质量边角（非本脚本职责，仅诊断）。
const ANOMALY_SQL = `
SELECT
  (SELECT COUNT(*)::int FROM client_wechat_users u
    WHERE u.customer_type = '会员客'
      AND NOT EXISTS (SELECT 1 FROM sale_orders o WHERE o.client_user_id = u.user_id
         AND o.status IN ('已支付','已完成') AND o.sale_order_type='销售单'
         AND o.total_amount >= $1::numeric)) AS member_no_qualifying,
  (SELECT COUNT(*)::int FROM client_wechat_users
    WHERE customer_type='会员客' AND became_member_at IS NULL) AS member_became_null,
  (SELECT COUNT(*)::int FROM client_wechat_users
    WHERE customer_type <> '会员客' AND became_member_at IS NOT NULL) AS nonmember_with_became
`

// UPDATE 后「有达标单的会员客」不应再缺 became_member_at（>0 则 ROLLBACK + exit 1）。
const SELFCHECK_SQL = `
SELECT COUNT(*)::int AS member_qualifying_still_null
  FROM client_wechat_users u
 WHERE u.customer_type='会员客' AND u.became_member_at IS NULL
   AND EXISTS (SELECT 1 FROM sale_orders o WHERE o.client_user_id=u.user_id
     AND o.status IN ('已支付','已完成') AND o.sale_order_type='销售单'
     AND o.total_amount >= $1::numeric)
`

async function main() {
  if (!PG_CONFIG.connectionString) {
    console.error('FATAL: DATABASE_URL 或 PG_CONNECTION_STRING 必须设置')
    process.exit(1)
  }

  log(`目标库: ${PG_CONFIG.connectionString.replace(/:[^:@]+@/, ':***@')}`)
  log(`模式: ${apply ? 'APPLY（实际写入）' : 'DRY-RUN（默认；加 --apply 提交）'}`)

  const pool = new Pool(PG_CONFIG)
  const client = await pool.connect()
  try {
    const thRes = await client.query(FETCH_THRESHOLD_SQL)
    if (!thRes.rows[0] || !thRes.rows[0].v || Number(thRes.rows[0].v) <= 0) {
      console.error('FATAL: system_configs.new_member_threshold 缺失或非法')
      process.exit(1)
    }
    const threshold = Number(thRes.rows[0].v)
    log(`new_member_threshold = ${threshold}`)

    await client.query('BEGIN')
    await client.query(BUILD_TARGET_SQL, [threshold])

    const preview = await client.query(PREVIEW_SQL)
    const p = preview.rows[0]
    log(`命中：${p.target_users} 会员客；将变更 ${p.users_to_change} 行（原 NULL ${p.users_pre_null}；前移 ${p.users_new_earlier}；后移 ${p.users_new_later}）`)

    const sample = await client.query(SAMPLE_SQL)
    if (sample.rows.length > 0) {
      log('抽样（前 20 行 user_id | old → new）：')
      for (const r of sample.rows) {
        log(`  ${r.user_id} | ${r.old_became} → ${r.new_became}`)
      }
    }

    const anom = await client.query(ANOMALY_SQL, [threshold])
    const a = anom.rows[0]
    log(`ANOMALY：会员客但当前阈值无达标单（保留原值）${a.member_no_qualifying} 人；会员客 became_member_at IS NULL ${a.member_became_null} 人；非会员客却带 became_member_at ${a.nonmember_with_became} 人`)

    if (apply) {
      const upd = await client.query(UPDATE_SQL)
      log(`APPLY 完成：已更新 ${upd.rowCount} 行 became_member_at`)

      const sc = await client.query(SELFCHECK_SQL, [threshold])
      if (sc.rows[0].member_qualifying_still_null > 0) {
        await client.query('ROLLBACK')
        console.error(`FATAL: SELFCHECK 失败：仍有 ${sc.rows[0].member_qualifying_still_null} 个「有达标单的会员客」became_member_at 为 NULL，已回滚`)
        process.exit(1)
      }
      await client.query('COMMIT')
      log('SELFCHECK 通过；事务已提交')
    } else {
      await client.query('ROLLBACK')
      log('DRY-RUN：已回滚，未写入。加 --apply 提交。')
    }
  } catch (err) {
    try { await client.query('ROLLBACK') } catch (_) {}
    console.error('FATAL:', err.message)
    console.error(err.stack)
    process.exit(1)
  } finally {
    client.release()
    await pool.end()
  }
}

main().catch((err) => {
  console.error('FATAL:', err)
  process.exit(1)
})
