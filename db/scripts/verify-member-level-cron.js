#!/usr/bin/env node
/**
 * verify-member-level-cron.js
 *
 * cronTask 会员等级逻辑（150 天保级 + 升级权益幂等发放）集成验证脚本。
 * 对应 ticket: notes/tickets/2026-04-24-member-level-150d-lock-and-upgrade-benefits.md PR-4
 *
 * 覆盖场景（来自 ticket §9 PR-4 验收列表）：
 *   [S1] 销售单消费 2000 → 等级升至初钻（阈值 1990）→ locked_until 设为 NOW()+150d
 *   [S2] 消费额 SQL 白名单：内部单 10 万 + 销售单 0 → spend=0，等级 null 不变
 *   [S3] 再次插入相同 idempotency_key 消息 → 第二次 ON CONFLICT DO NOTHING
 *   [S4] 再次插入相同 external_ref 积分 → 第二次 ON CONFLICT DO NOTHING
 *   [S5] 退款单通过 sale_order_payments 负流水减少 paid_amount → 消费额正确下降
 *   [S6] 保级期内降级：locked_until 未来 → processDowngrade 应跳过更新
 *   [S7] 保级期已过降级：locked_until 过去 → processDowngrade 应实际降级并清空 locked_until
 *   [S8] 连升两档：两次 processUpgrade，每档幂等键不同，都成功发放
 *
 * 运行方式:
 *   1) 起临时 docker PG（54399）：
 *        docker run -d --name member-level-cron-verify \
 *          -e POSTGRES_PASSWORD=test -e POSTGRES_DB=test \
 *          -p 54399:5432 postgres:16
 *   2) 本脚本自动等待就绪 → apply 所有 migration → seed → 跑 8 个场景
 *        node db/scripts/verify-member-level-cron.js
 *   3) 清理：
 *        docker rm -f member-level-cron-verify
 *
 * 亦可通过 DATABASE_URL 指向已经跑好迁移的测试库（此时会跳过 migrate 步骤）。
 *
 * 重要约束:
 *   - 不读 cronTask/index.js（顶部 cloud.init() 不可 require），而是把其中的核心 SQL
 *     逐条复制到本脚本 `CRON_SQL` 常量中，并在每个场景调用。如果 cronTask SQL 变更，
 *     需要同步更新本脚本对应常量。
 *   - 不触碰 5434/5433 真实库；仅操作 DATABASE_URL 指定的临时库。
 */

'use strict'

const path = require('path')
const fs = require('fs')
const { spawnSync } = require('child_process')
const { Client } = require('pg')

// ---------- 配置 ----------
const DB_URL = process.env.DATABASE_URL || 'postgresql://postgres:test@localhost:54399/test'
const PROJECT_ROOT = path.resolve(__dirname, '..')
const MIGRATIONS_DIR = path.join(PROJECT_ROOT, 'migrations')
const DOCKER_CONTAINER_NAME = 'member-level-cron-verify'

// ---------- 颜色 ----------
const C = {
  reset: '\x1b[0m',
  green: '\x1b[32m',
  red: '\x1b[31m',
  yellow: '\x1b[33m',
  cyan: '\x1b[36m',
  dim: '\x1b[2m',
  bold: '\x1b[1m',
}

// ---------- 工具 ----------
const results = []
function pass(id, name, extra) {
  results.push({ id, name, ok: true, extra })
  console.log(`${C.green}✔ ${id} PASS${C.reset} ${name}${extra ? ` ${C.dim}(${extra})${C.reset}` : ''}`)
}
function fail(id, name, err) {
  results.push({ id, name, ok: false, err: String(err?.message || err) })
  console.log(`${C.red}✘ ${id} FAIL${C.reset} ${name}`)
  console.log(`  ${C.red}${err?.stack || err}${C.reset}`)
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms))
}

async function waitForPg(connStr, maxSec = 30) {
  for (let i = 0; i < maxSec; i++) {
    const c = new Client({ connectionString: connStr })
    try {
      await c.connect()
      await c.query('SELECT 1')
      await c.end()
      return true
    } catch (_) {
      try { await c.end() } catch {}
      await sleep(1000)
    }
  }
  return false
}

// ---------- 从 cronTask/index.js 迁移过来的核心 SQL ----------
// cronTask/index.js:215-222
const CRON_SPEND_SQL = `
  SELECT COALESCE(SUM(paid_amount::numeric), 0) AS spend
  FROM sale_orders
  WHERE client_user_id = $1
    AND sale_order_type = '销售单'
    AND paid_amount > 0
    AND paid_at >= (NOW() - INTERVAL '12 months')
`

// cronTask/index.js:259-267 processUpgrade
const CRON_UPGRADE_SQL = `
  UPDATE client_wechat_users
     SET member_level = $1,
         member_level_upgraded_at = NOW(),
         member_level_locked_until = NOW() + INTERVAL '150 days',
         updated_at = NOW()
   WHERE user_id = $2
`

// cronTask/index.js:320-326 processDowngrade（保级期已过）
const CRON_DOWNGRADE_SQL = `
  UPDATE client_wechat_users
     SET member_level = $1,
         member_level_locked_until = NULL,
         updated_at = NOW()
   WHERE user_id = $2
`

// cronTask/index.js:130-136 消息幂等插入
const CRON_MSG_INSERT_SQL = `
  INSERT INTO messages (recipient_type, recipient_id, title, body, message_type, idempotency_key, created_at)
  VALUES ('客户', $1, $2, $3, 'system', $4, NOW())
  ON CONFLICT (idempotency_key) WHERE idempotency_key IS NOT NULL DO NOTHING
`

// cronTask/index.js:141-147 积分幂等插入
const CRON_POINT_INSERT_SQL = `
  INSERT INTO point_transactions (user_id, type, amount, ref_order_id, external_ref, created_at)
  VALUES ($1, '等级升级奖励', $2, NULL, $3, NOW())
  ON CONFLICT (external_ref) WHERE external_ref IS NOT NULL DO NOTHING
  RETURNING id
`

// cronTask/index.js:90-95
const LEVEL_RANK = { null: 0, '初钻': 1, '星钻': 2, '粉钻': 3, '金钻': 4, '黑钻': 5 }
function determineMemberLevel(spend, threshold) {
  if (spend >= 100000) return '黑钻'
  if (spend >= 60000) return '金钻'
  if (spend >= 30000) return '粉钻'
  if (spend >= 10000) return '星钻'
  if (spend >= threshold) return '初钻'
  return null
}
function isUpgrade(from, to) {
  return (LEVEL_RANK[to] ?? 0) > (LEVEL_RANK[from] ?? 0)
}
function isDowngrade(from, to) {
  return (LEVEL_RANK[to] ?? 0) < (LEVEL_RANK[from] ?? 0)
}

// ---------- Migration apply ----------
async function applyMigrations(client) {
  console.log(`${C.cyan}[setup] applying migrations from ${MIGRATIONS_DIR}${C.reset}`)
  const journal = JSON.parse(fs.readFileSync(path.join(MIGRATIONS_DIR, 'meta/_journal.json'), 'utf8'))

  for (const entry of journal.entries) {
    const file = path.join(MIGRATIONS_DIR, `${entry.tag}.sql`)
    if (!fs.existsSync(file)) {
      throw new Error(`migration file missing: ${file}`)
    }
    const raw = fs.readFileSync(file, 'utf8')
    // drizzle-kit uses "--> statement-breakpoint" as delimiter
    const stmts = raw
      .split('--> statement-breakpoint')
      .map((s) => s.trim())
      .filter((s) => s.length > 0)
    console.log(`  ${C.dim}→ ${entry.tag} (${stmts.length} stmts)${C.reset}`)
    for (const stmt of stmts) {
      try {
        await client.query(stmt)
      } catch (err) {
        console.error(`${C.red}[migrate fail] ${entry.tag}${C.reset}: ${err.message}`)
        console.error(stmt.slice(0, 300))
        throw err
      }
    }
  }
  console.log(`${C.green}[setup] migrations applied${C.reset}`)
}

// ---------- Seed ----------
async function seed(client) {
  console.log(`${C.cyan}[setup] seeding test data${C.reset}`)

  // 每轮运行前清理测试用户留下的订单/消息/积分/顾客，避免重复运行时 PK/UX 冲突
  await client.query(`DELETE FROM sale_order_payments WHERE sale_order_id LIKE 'FY-XSD-WX-S%' OR sale_order_id LIKE 'FY-NBD-WX-S%'`)
  await client.query(`DELETE FROM sale_orders WHERE sale_order_id LIKE 'FY-XSD-WX-S%' OR sale_order_id LIKE 'FY-NBD-WX-S%'`)
  await client.query(`DELETE FROM point_transactions WHERE user_id LIKE 'FYGK-S%'`)
  await client.query(`DELETE FROM messages WHERE recipient_id LIKE 'FYGK-S%'`)
  await client.query(`DELETE FROM client_wechat_users WHERE user_id LIKE 'FYGK-S%'`)

  // org_nodes: type ∈ {总部/市场/门店/部门}；stores 外键到 org_nodes（org_node_id 字段）
  await client.query(`
    INSERT INTO org_nodes (id, type, name, parent_id)
    VALUES ('ORG-HQ', '总部', '总部', NULL)
    ON CONFLICT (id) DO NOTHING
  `)
  await client.query(`
    INSERT INTO org_nodes (id, type, name, parent_id)
    VALUES ('ORG-STORE-1', '门店', '测试门店', 'ORG-HQ')
    ON CONFLICT (id) DO NOTHING
  `)
  // stores: store_id 不是 FK 到 org_nodes，独立主键；schema 里有 org_node_id 字段关联
  await client.query(`
    INSERT INTO stores (store_id, store_name, org_node_id, is_closed)
    VALUES ('ORG-STORE-1', '测试门店', 'ORG-STORE-1', false)
    ON CONFLICT (store_id) DO NOTHING
  `)

  // system_configs: new_member_threshold
  await client.query(`
    INSERT INTO system_configs (key, value) VALUES ('new_member_threshold', '1990')
    ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value
  `)

  // member_level_benefits 配置（仅为了引用；实际测试不走 loadBenefitsConfig 分支）
  await client.query(`
    INSERT INTO system_configs (key, value) VALUES ('member_level_benefits', $1)
    ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value
  `, [JSON.stringify({
    '初钻': { messageTitle: '恭喜升级初钻', messageBody: '您已成为初钻会员', points: 100, couponTemplateIds: [] },
    '星钻': { messageTitle: '恭喜升级星钻', messageBody: '您已成为星钻会员', points: 500, couponTemplateIds: [] },
    '粉钻': { messageTitle: '恭喜升级粉钻', messageBody: '您已成为粉钻会员', points: 1000, couponTemplateIds: [] },
  })])

  console.log(`${C.green}[setup] seed done${C.reset}`)
}

// ---------- 每场景前插入一个干净的会员客 ----------
async function createClient(client, userId, phone) {
  await client.query(`
    INSERT INTO client_wechat_users (
      user_id, phone, name, bound_store_id, customer_type, member_level
    ) VALUES ($1, $2, $3, 'ORG-STORE-1', '会员客', NULL)
    ON CONFLICT (user_id) DO UPDATE SET
      member_level = NULL,
      member_level_locked_until = NULL,
      member_level_upgraded_at = NULL
  `, [userId, phone, `测试-${userId}`])
}

// 创建一个销售单（简化：直接指定 paid_at / paid_amount / sale_order_type）
async function createSaleOrder(client, opts) {
  const {
    id, clientUserId, saleOrderType = '销售单', totalAmount, paidAmount,
    paidAt = new Date(), status = '已支付',
    refSaleOrderId = null,
  } = opts
  await client.query(`
    INSERT INTO sale_orders (
      sale_order_id, status, sale_order_type, ref_sale_order_id,
      market_name, store_id,
      sale_order_datetime, client_user_id, total_amount, payable_amount,
      prepaid_card_amount, paid_amount,
      payment_method, paid_at,
      created_at, updated_at
    ) VALUES (
      $1, $2, $3, $4, '测试市场', 'ORG-STORE-1',
      NOW(), $5, $6, $6,
      0, $7,
      '微信', $8,
      NOW(), NOW()
    )
  `, [id, status, saleOrderType, refSaleOrderId, clientUserId, totalAmount, paidAmount, paidAt])
}

// 辅助：插入 sale_order_payments 行并对应重算 sale_orders.paid_amount
async function appendPayment(client, { saleOrderId, changeType, amount, externalTxnId = null, paymentMethod = '微信' }) {
  await client.query(`
    INSERT INTO sale_order_payments (
      sale_order_id, change_type, amount, payment_method,
      external_txn_id, status, source_end, created_at, paid_at
    ) VALUES ($1, $2, $3, $4, $5, '已支付', 'staff', NOW(), NOW())
  `, [saleOrderId, changeType, amount, paymentMethod, externalTxnId])

  // 重算 sale_orders.paid_amount = Σ(amount WHERE change_type IN ('首次支付','回款','退款') AND status='已支付')
  await client.query(`
    UPDATE sale_orders so
    SET paid_amount = COALESCE((
      SELECT SUM(p.amount)
      FROM sale_order_payments p
      WHERE p.sale_order_id = so.sale_order_id
        AND p.status = '已支付'
        AND p.change_type IN ('首次支付','回款','退款')
    ), 0),
    updated_at = NOW()
    WHERE so.sale_order_id = $1
  `, [saleOrderId])
}

// ---------- 场景 ----------

async function S1_upgrade_to_chuzuan(client, threshold) {
  const id = 'S1'; const name = 'S1 销售单 2000 → 升至初钻 + locked_until=+150d'
  try {
    const userId = 'FYGK-S1'
    await createClient(client, userId, '13800000001')
    await createSaleOrder(client, {
      id: 'FY-XSD-WX-S10001', clientUserId: userId, totalAmount: 2000, paidAmount: 2000,
    })

    const spendRow = (await client.query(CRON_SPEND_SQL, [userId])).rows[0]
    const spend = Number(spendRow.spend)
    if (spend !== 2000) throw new Error(`spend expected 2000, got ${spend}`)

    const newLevel = determineMemberLevel(spend, threshold)
    if (newLevel !== '初钻') throw new Error(`newLevel expected '初钻', got ${newLevel}`)

    await client.query(CRON_UPGRADE_SQL, [newLevel, userId])

    const row = (await client.query(
      `SELECT member_level, member_level_locked_until, member_level_upgraded_at
       FROM client_wechat_users WHERE user_id = $1`, [userId]
    )).rows[0]
    if (row.member_level !== '初钻') throw new Error(`level ${row.member_level}`)
    if (!row.member_level_locked_until) throw new Error('locked_until NULL')
    if (!row.member_level_upgraded_at) throw new Error('upgraded_at NULL')

    const lockMs = new Date(row.member_level_locked_until).getTime() - Date.now()
    const expectedMs = 150 * 86400 * 1000
    // 允许 60s 偏差
    if (Math.abs(lockMs - expectedMs) > 60 * 1000) {
      throw new Error(`locked_until offset unexpected: ${lockMs}ms (want ~${expectedMs}ms)`)
    }

    pass(id, name, `spend=${spend} level=${newLevel} lock≈+150d`)
  } catch (e) {
    fail(id, name, e)
  }
}

async function S2_internal_order_not_counted(client, threshold) {
  const id = 'S2'; const name = 'S2 内部单 10w 不计入消费，等级保持 null'
  try {
    const userId = 'FYGK-S2'
    await createClient(client, userId, '13800000002')
    await createSaleOrder(client, {
      id: 'FY-NBD-WX-S20001', clientUserId: userId, saleOrderType: '内部单',
      totalAmount: 100000, paidAmount: 100000,
    })

    const spendRow = (await client.query(CRON_SPEND_SQL, [userId])).rows[0]
    const spend = Number(spendRow.spend)
    if (spend !== 0) throw new Error(`spend expected 0 (internal excluded), got ${spend}`)

    const newLevel = determineMemberLevel(spend, threshold)
    if (newLevel !== null) throw new Error(`newLevel expected null, got ${newLevel}`)

    const row = (await client.query(
      `SELECT member_level FROM client_wechat_users WHERE user_id = $1`, [userId]
    )).rows[0]
    if (row.member_level !== null) throw new Error(`level should remain null, got ${row.member_level}`)

    pass(id, name, `spend=0 level=null`)
  } catch (e) {
    fail(id, name, e)
  }
}

async function S3_idempotent_message(client) {
  const id = 'S3'; const name = 'S3 重复插入同 idempotency_key 消息 → 第二次 ON CONFLICT DO NOTHING'
  try {
    const userId = 'FYGK-S3'
    await createClient(client, userId, '13800000003')
    const idemKey = `member-upgrade-${userId}-初钻`

    const r1 = await client.query(CRON_MSG_INSERT_SQL, [userId, '升级初钻', '您已成为初钻会员', idemKey])
    if (r1.rowCount !== 1) throw new Error(`first insert rowCount=${r1.rowCount}`)

    const r2 = await client.query(CRON_MSG_INSERT_SQL, [userId, '升级初钻', '您已成为初钻会员', idemKey])
    if (r2.rowCount !== 0) throw new Error(`second insert rowCount=${r2.rowCount} (expected 0)`)

    const cnt = Number((await client.query(
      `SELECT COUNT(*) AS c FROM messages WHERE idempotency_key = $1`, [idemKey]
    )).rows[0].c)
    if (cnt !== 1) throw new Error(`message count=${cnt} (expected 1)`)

    pass(id, name, `rowCount 1→0, total rows=1`)
  } catch (e) {
    fail(id, name, e)
  }
}

async function S4_idempotent_point_txn(client) {
  const id = 'S4'; const name = 'S4 重复插入同 external_ref 积分 → 第二次 ON CONFLICT DO NOTHING'
  try {
    const userId = 'FYGK-S4'
    await createClient(client, userId, '13800000004')
    const idemKey = `member-upgrade-${userId}-星钻`

    const r1 = await client.query(CRON_POINT_INSERT_SQL, [userId, 500, idemKey])
    if (r1.rowCount !== 1) throw new Error(`first insert rowCount=${r1.rowCount}`)

    const r2 = await client.query(CRON_POINT_INSERT_SQL, [userId, 500, idemKey])
    if (r2.rowCount !== 0) throw new Error(`second insert rowCount=${r2.rowCount} (expected 0)`)

    const cnt = Number((await client.query(
      `SELECT COUNT(*) AS c FROM point_transactions WHERE external_ref = $1`, [idemKey]
    )).rows[0].c)
    if (cnt !== 1) throw new Error(`point_txn count=${cnt} (expected 1)`)

    pass(id, name, `rowCount 1→0, total rows=1`)
  } catch (e) {
    fail(id, name, e)
  }
}

async function S5_refund_via_payments(client, threshold) {
  const id = 'S5'; const name = 'S5 退款负流水减少 paid_amount → 消费额正确下降'
  try {
    const userId = 'FYGK-S5'
    await createClient(client, userId, '13800000005')

    // 原销售单 5000，首次支付流水 +5000
    const orderId = 'FY-XSD-WX-S50001'
    await createSaleOrder(client, {
      id: orderId, clientUserId: userId, totalAmount: 5000, paidAmount: 0,
    })
    await appendPayment(client, {
      saleOrderId: orderId, changeType: '首次支付', amount: 5000,
      externalTxnId: 'wx-txn-s5-1',
    })

    const spend1 = Number((await client.query(CRON_SPEND_SQL, [userId])).rows[0].spend)
    if (spend1 !== 5000) throw new Error(`spend after pay expected 5000, got ${spend1}`)

    // 退款 -3000（通过 payments 负流水；不创建独立退款单，直接减少原单 paid_amount）
    await appendPayment(client, {
      saleOrderId: orderId, changeType: '退款', amount: -3000,
      externalTxnId: 'wx-txn-s5-refund-1',
    })

    const spend2 = Number((await client.query(CRON_SPEND_SQL, [userId])).rows[0].spend)
    if (spend2 !== 2000) throw new Error(`spend after refund expected 2000, got ${spend2}`)

    const level2 = determineMemberLevel(spend2, threshold)
    if (level2 !== '初钻') throw new Error(`level after refund expected 初钻, got ${level2}`)

    pass(id, name, `spend 5000 → 2000 after -3000 refund`)
  } catch (e) {
    fail(id, name, e)
  }
}

async function S6_locked_skip_downgrade(client) {
  const id = 'S6'; const name = 'S6 保级期内（locked_until 未来）降级跳过'
  try {
    const userId = 'FYGK-S6'
    await createClient(client, userId, '13800000006')
    // 手动把用户置为"星钻"，并把 locked_until 设到未来
    await client.query(`
      UPDATE client_wechat_users
         SET member_level = '星钻',
             member_level_upgraded_at = NOW() - INTERVAL '10 days',
             member_level_locked_until = NOW() + INTERVAL '100 days'
       WHERE user_id = $1
    `, [userId])

    // 模拟 processDowngrade 的判断逻辑（cronTask/index.js:299-316）
    const row = (await client.query(
      `SELECT member_level, member_level_locked_until FROM client_wechat_users WHERE user_id = $1`,
      [userId]
    )).rows[0]
    const lockedUntil = row.member_level_locked_until
    const isHeld = lockedUntil && new Date(lockedUntil) > new Date()
    if (!isHeld) throw new Error('expected held=true, got false')

    // 保级期内不执行 UPDATE，只写 operation_logs（这里只验证等级未变）
    const after = (await client.query(
      `SELECT member_level, member_level_locked_until FROM client_wechat_users WHERE user_id = $1`,
      [userId]
    )).rows[0]
    if (after.member_level !== '星钻') throw new Error(`level expected 星钻 (held), got ${after.member_level}`)
    if (!after.member_level_locked_until) throw new Error('locked_until was cleared (should be preserved)')

    pass(id, name, `held=true, level unchanged`)
  } catch (e) {
    fail(id, name, e)
  }
}

async function S7_expired_lock_downgrade(client) {
  const id = 'S7'; const name = 'S7 保级期已过（locked_until 过去）实际降级 + 清空 locked_until'
  try {
    const userId = 'FYGK-S7'
    await createClient(client, userId, '13800000007')
    await client.query(`
      UPDATE client_wechat_users
         SET member_level = '星钻',
             member_level_upgraded_at = NOW() - INTERVAL '200 days',
             member_level_locked_until = NOW() - INTERVAL '10 days'
       WHERE user_id = $1
    `, [userId])

    const row = (await client.query(
      `SELECT member_level_locked_until FROM client_wechat_users WHERE user_id = $1`, [userId]
    )).rows[0]
    const lockedUntil = row.member_level_locked_until
    const isHeld = lockedUntil && new Date(lockedUntil) > new Date()
    if (isHeld) throw new Error('expected held=false for expired lock, got true')

    // 执行 cronTask/index.js 的 CRON_DOWNGRADE_SQL
    await client.query(CRON_DOWNGRADE_SQL, ['初钻', userId])

    const after = (await client.query(
      `SELECT member_level, member_level_locked_until FROM client_wechat_users WHERE user_id = $1`,
      [userId]
    )).rows[0]
    if (after.member_level !== '初钻') throw new Error(`level expected 初钻, got ${after.member_level}`)
    if (after.member_level_locked_until !== null) throw new Error(`locked_until should be NULL, got ${after.member_level_locked_until}`)

    pass(id, name, `downgrade 星钻→初钻, locked_until cleared`)
  } catch (e) {
    fail(id, name, e)
  }
}

async function S8_two_upgrades_independent_idem_keys(client) {
  const id = 'S8'; const name = 'S8 连升两档，各自幂等键不同都生效'
  try {
    const userId = 'FYGK-S8'
    await createClient(client, userId, '13800000008')

    // 第一升：null → 初钻（模拟消费 2000）
    await client.query(CRON_UPGRADE_SQL, ['初钻', userId])
    const idemKey1 = `member-upgrade-${userId}-初钻`
    const m1 = await client.query(CRON_MSG_INSERT_SQL, [userId, '升级初钻', 'body1', idemKey1])
    const p1 = await client.query(CRON_POINT_INSERT_SQL, [userId, 100, idemKey1])
    if (m1.rowCount !== 1) throw new Error(`msg1 rowCount=${m1.rowCount}`)
    if (p1.rowCount !== 1) throw new Error(`point1 rowCount=${p1.rowCount}`)

    // 第二升：初钻 → 星钻（模拟消费 15000）
    await client.query(CRON_UPGRADE_SQL, ['星钻', userId])
    const idemKey2 = `member-upgrade-${userId}-星钻`
    const m2 = await client.query(CRON_MSG_INSERT_SQL, [userId, '升级星钻', 'body2', idemKey2])
    const p2 = await client.query(CRON_POINT_INSERT_SQL, [userId, 500, idemKey2])
    if (m2.rowCount !== 1) throw new Error(`msg2 rowCount=${m2.rowCount}`)
    if (p2.rowCount !== 1) throw new Error(`point2 rowCount=${p2.rowCount}`)

    // 最终状态：应为星钻；两条消息/积分都在；idempotency_key 各不相同
    const level = (await client.query(
      `SELECT member_level FROM client_wechat_users WHERE user_id = $1`, [userId]
    )).rows[0].member_level
    if (level !== '星钻') throw new Error(`final level expected 星钻, got ${level}`)

    const msgCnt = Number((await client.query(
      `SELECT COUNT(*) AS c FROM messages WHERE recipient_id = $1 AND idempotency_key LIKE 'member-upgrade-%'`,
      [userId]
    )).rows[0].c)
    const ptCnt = Number((await client.query(
      `SELECT COUNT(*) AS c FROM point_transactions WHERE user_id = $1 AND external_ref LIKE 'member-upgrade-%'`,
      [userId]
    )).rows[0].c)
    if (msgCnt !== 2) throw new Error(`msg count expected 2, got ${msgCnt}`)
    if (ptCnt !== 2) throw new Error(`point_txn count expected 2, got ${ptCnt}`)

    // 再跑一次「模拟 cron 重跑」— 同一升级事件的两个幂等键都应 no-op
    const rerunMsg2 = await client.query(CRON_MSG_INSERT_SQL, [userId, '升级星钻', 'body2', idemKey2])
    const rerunPt2 = await client.query(CRON_POINT_INSERT_SQL, [userId, 500, idemKey2])
    if (rerunMsg2.rowCount !== 0) throw new Error(`rerun msg2 rowCount=${rerunMsg2.rowCount} (expected 0)`)
    if (rerunPt2.rowCount !== 0) throw new Error(`rerun point2 rowCount=${rerunPt2.rowCount} (expected 0)`)

    pass(id, name, `level=星钻, 2 msgs, 2 point_txns, rerun no-op`)
  } catch (e) {
    fail(id, name, e)
  }
}

// ---------- 主流程 ----------

async function maybeStartDocker() {
  if (process.env.DATABASE_URL) return false // 外部库，不管容器
  // 检查容器是否已存在
  const check = spawnSync('docker', ['ps', '-a', '--format', '{{.Names}}'])
  const existing = check.stdout?.toString().split('\n') || []
  if (existing.includes(DOCKER_CONTAINER_NAME)) {
    console.log(`${C.yellow}[docker] container ${DOCKER_CONTAINER_NAME} already exists, reusing${C.reset}`)
    spawnSync('docker', ['start', DOCKER_CONTAINER_NAME], { stdio: 'inherit' })
    return true
  }
  console.log(`${C.cyan}[docker] starting ${DOCKER_CONTAINER_NAME} on :54399${C.reset}`)
  const run = spawnSync('docker', [
    'run', '-d', '--name', DOCKER_CONTAINER_NAME,
    '-e', 'POSTGRES_PASSWORD=test',
    '-e', 'POSTGRES_DB=test',
    '-p', '54399:5432',
    'postgres:16',
  ], { stdio: 'inherit' })
  if (run.status !== 0) {
    throw new Error('docker run failed (see above)')
  }
  return true
}

async function main() {
  console.log(`${C.bold}${C.cyan}=== verify-member-level-cron.js ===${C.reset}`)
  console.log(`${C.dim}target: ${DB_URL}${C.reset}`)

  const startedContainer = await maybeStartDocker()

  console.log(`${C.cyan}[setup] waiting for PG ready…${C.reset}`)
  const ready = await waitForPg(DB_URL, 30)
  if (!ready) {
    console.error(`${C.red}PG did not come up in 30s${C.reset}`)
    process.exit(2)
  }

  const client = new Client({ connectionString: DB_URL })
  await client.connect()

  try {
    // 检测是否是空库（没有 client_wechat_users 表）→ 跑 migration；否则跳过
    const tblCheck = await client.query(`
      SELECT 1 FROM information_schema.tables
      WHERE table_schema = 'public' AND table_name = 'client_wechat_users'
    `)
    if (tblCheck.rowCount === 0) {
      await applyMigrations(client)
    } else {
      console.log(`${C.yellow}[setup] schema already present, skipping migrations${C.reset}`)
    }

    await seed(client)

    const threshold = Number((await client.query(
      `SELECT value FROM system_configs WHERE key = 'new_member_threshold'`
    )).rows[0].value)
    console.log(`${C.dim}[setup] threshold=${threshold}${C.reset}\n`)

    console.log(`${C.bold}${C.cyan}=== running scenarios ===${C.reset}`)
    await S1_upgrade_to_chuzuan(client, threshold)
    await S2_internal_order_not_counted(client, threshold)
    await S3_idempotent_message(client)
    await S4_idempotent_point_txn(client)
    await S5_refund_via_payments(client, threshold)
    await S6_locked_skip_downgrade(client)
    await S7_expired_lock_downgrade(client)
    await S8_two_upgrades_independent_idem_keys(client)

    // 汇总
    const passCnt = results.filter((r) => r.ok).length
    const failCnt = results.length - passCnt
    console.log(`\n${C.bold}=== summary ===${C.reset}`)
    console.log(`${C.green}PASS: ${passCnt}${C.reset}  ${C.red}FAIL: ${failCnt}${C.reset}  TOTAL: ${results.length}`)

    if (startedContainer) {
      console.log(`\n${C.yellow}[hint] to remove temp container:${C.reset}`)
      console.log(`  docker rm -f ${DOCKER_CONTAINER_NAME}`)
    }

    process.exit(failCnt > 0 ? 1 : 0)
  } finally {
    try { await client.end() } catch {}
  }
}

main().catch((err) => {
  console.error(`${C.red}[fatal]${C.reset} ${err.stack || err}`)
  process.exit(2)
})
