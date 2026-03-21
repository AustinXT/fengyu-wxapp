#!/usr/bin/env node
/**
 * migrate-prepaid-cards.js — 从已导入的 sale_items 生成 prepaid_cards + card_transactions
 *
 * 识别已导入的充值/储值/预存类 sale_items，转化为 prepaid_cards 记录，
 * 使客户端可以看到历史充值卡余额。
 *
 * 数据源：PG sale_items（Round 1 已导入），无需连接 WorkFine
 * 余额计算：balance = remaining_sessions / session_count * sale_amount
 *
 * 用法：
 *   node scripts/migrate-prepaid-cards.js              # 正式执行
 *   node scripts/migrate-prepaid-cards.js --dry-run     # 预览模式
 *   node scripts/migrate-prepaid-cards.js --verify      # 仅验证
 *
 * 幂等设计：ON CONFLICT (card_id) DO UPDATE
 */

const { Pool } = require('pg')

const PG_CONFIG = {
  connectionString: process.env.DATABASE_URL || 'postgresql://fengyu:fengyu123@47.113.202.7:5433/fengyu_wxapp',
  max: 5,
}

function log(msg) { console.log(`[CARDS] ${msg}`) }

// ─── 1. 查询充值卡类 sale_items ─────────────────────────────

async function queryPrepaidItems(pgPool) {
  log('查询充值卡类 sale_items...')

  const { rows } = await pgPool.query(`
    SELECT
      si.sale_item_id,
      si.product_name,
      si.session_count,
      si.remaining_sessions,
      si.sale_amount,
      si.unit_price,
      si.received,
      si.expire_date,
      so.sale_order_id,
      so.client_user_id,
      so.store_id,
      so.sale_order_datetime
    FROM sale_items si
    JOIN sale_orders so ON si.sale_order_id = so.sale_order_id
    WHERE so.remark = 'WorkFine历史订单导入'
      AND si.remaining_sessions > 0
      AND so.client_user_id IS NOT NULL
      AND (
        si.product_name LIKE '%充值%' OR
        si.product_name LIKE '%储值%' OR
        si.product_name LIKE '%预存%' OR
        si.product_name LIKE '%余额%'
      )
    ORDER BY so.client_user_id, si.sale_item_id
  `)

  log(`查询到 ${rows.length} 条充值卡类项目`)
  return rows
}

// ─── 2. 计算余额并生成记录 ──────────────────────────────────

function generateCards(items) {
  const cards = []
  let skippedZeroBalance = 0

  for (const item of items) {
    const sessionCount = parseInt(item.session_count) || 0
    const remaining = parseInt(item.remaining_sessions) || 0
    const saleAmount = parseFloat(item.sale_amount) || 0
    const unitPrice = parseFloat(item.unit_price) || 0
    const received = parseFloat(item.received) || 0

    // 计算余额
    let balance = 0
    if (sessionCount > 0 && saleAmount > 0) {
      balance = Math.round((remaining / sessionCount) * saleAmount * 100) / 100
    } else if (sessionCount > 0 && unitPrice > 0) {
      // 赠品用原价估算
      balance = Math.round((remaining / sessionCount) * unitPrice * 100) / 100
    } else if (remaining > 0 && received > 0) {
      // 后备：用实收金额
      balance = Math.round((remaining / Math.max(sessionCount, 1)) * received * 100) / 100
    }

    if (balance <= 0) {
      skippedZeroBalance++
      continue
    }

    cards.push({
      cardId: `CARD-${item.sale_item_id}`,
      userId: item.client_user_id,
      balance,
      storeId: item.store_id,
      saleOrderId: item.sale_order_id,
      saleOrderDatetime: item.sale_order_datetime,
      productName: item.product_name,
    })
  }

  log(`生成 ${cards.length} 条充值卡记录（跳过 ${skippedZeroBalance} 条零余额）`)
  return cards
}

// ─── 3. 写入 PG ─────────────────────────────────────────────

async function upsertCards(pgPool, cards, dryRun) {
  if (dryRun) {
    log(`[DRY] 将导入 ${cards.length} 条充值卡 + ${cards.length} 条初始流水`)

    // 预览前 10 条
    cards.slice(0, 10).forEach((c, i) => {
      console.log(`  [DRY] ${i + 1}. ${c.cardId} | user=${c.userId} | ¥${c.balance} | ${c.productName}`)
    })
    if (cards.length > 10) console.log(`  ... 及 ${cards.length - 10} 条更多`)
    return cards.length
  }

  const client = await pgPool.connect()
  try {
    await client.query('BEGIN')

    let cardCount = 0
    let txnCount = 0

    for (const card of cards) {
      // UPSERT prepaid_card
      await client.query(`
        INSERT INTO prepaid_cards (card_id, user_id, balance, store_id, created_at)
        VALUES ($1, $2, $3, $4, $5)
        ON CONFLICT (card_id) DO UPDATE SET
          balance = EXCLUDED.balance,
          updated_at = now()
      `, [
        card.cardId,
        card.userId,
        card.balance,
        card.storeId,
        card.saleOrderDatetime || new Date(),
      ])
      cardCount++

      // UPSERT 初始 topup 流水（用 ref_order_id 去重）
      // 先检查是否已有该卡的 topup 记录
      const existing = await client.query(
        "SELECT id FROM card_transactions WHERE card_id = $1 AND type = 'topup' AND ref_order_id = $2",
        [card.cardId, card.saleOrderId]
      )

      if (existing.rows.length === 0) {
        await client.query(`
          INSERT INTO card_transactions (card_id, type, amount, ref_order_id, created_at)
          VALUES ($1, 'topup', $2, $3, $4)
        `, [
          card.cardId,
          card.balance,
          card.saleOrderId,
          card.saleOrderDatetime || new Date(),
        ])
        txnCount++
      }
    }

    await client.query('COMMIT')
    log(`导入完成：${cardCount} 条充值卡, ${txnCount} 条初始流水`)
    return cardCount
  } catch (err) {
    await client.query('ROLLBACK')
    throw err
  } finally {
    client.release()
  }
}

// ─── 4. 验证 ────────────────────────────────────────────────

async function verify(pgPool) {
  console.log('\n=== 数据验证 ===')

  const cards = await pgPool.query(
    "SELECT COUNT(*) AS cnt, SUM(balance) AS total, COUNT(DISTINCT user_id) AS users FROM prepaid_cards"
  )
  console.log(`  充值卡总数: ${cards.rows[0].cnt}`)
  console.log(`  总余额: ¥${parseFloat(cards.rows[0].total || 0).toFixed(2)}`)
  console.log(`  涉及顾客: ${cards.rows[0].users}`)

  const txns = await pgPool.query(
    "SELECT COUNT(*) AS cnt, SUM(amount) AS total FROM card_transactions WHERE type = 'topup'"
  )
  console.log(`  充值流水: ${txns.rows[0].cnt} 条, 总额 ¥${parseFloat(txns.rows[0].total || 0).toFixed(2)}`)

  // FK 完整性
  console.log('\n  FK 完整性:')
  const orphanUser = await pgPool.query(
    "SELECT COUNT(*) AS cnt FROM prepaid_cards p WHERE NOT EXISTS (SELECT 1 FROM client_wechat_users c WHERE c.user_id = p.user_id)"
  )
  console.log(`    孤立 user_id: ${orphanUser.rows[0].cnt}`)

  const orphanStore = await pgPool.query(
    "SELECT COUNT(*) AS cnt FROM prepaid_cards p WHERE p.store_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM stores s WHERE s.store_id = p.store_id)"
  )
  console.log(`    孤立 store_id: ${orphanStore.rows[0].cnt}`)

  const orphanTxn = await pgPool.query(
    "SELECT COUNT(*) AS cnt FROM card_transactions ct WHERE NOT EXISTS (SELECT 1 FROM prepaid_cards p WHERE p.card_id = ct.card_id)"
  )
  console.log(`    孤立流水 card_id: ${orphanTxn.rows[0].cnt}`)

  // 余额分布
  const dist = await pgPool.query(`
    SELECT
      CASE
        WHEN balance < 100 THEN '< ¥100'
        WHEN balance < 500 THEN '¥100-500'
        WHEN balance < 2000 THEN '¥500-2000'
        WHEN balance < 10000 THEN '¥2000-10000'
        ELSE '¥10000+'
      END AS tier,
      COUNT(*) AS cnt,
      SUM(balance) AS total
    FROM prepaid_cards
    GROUP BY 1
    ORDER BY MIN(balance)
  `)
  console.log('\n  余额分布:')
  dist.rows.forEach(r => console.log(`    ${r.tier}: ${r.cnt} 张, ¥${parseFloat(r.total).toFixed(2)}`))

  // 余额-流水一致性
  const mismatch = await pgPool.query(`
    SELECT COUNT(*) AS cnt
    FROM prepaid_cards p
    WHERE ABS(p.balance - COALESCE((
      SELECT SUM(CASE WHEN type = 'topup' THEN amount ELSE -amount END)
      FROM card_transactions WHERE card_id = p.card_id
    ), 0)) > 0.01
  `)
  console.log(`\n  余额-流水不一致: ${mismatch.rows[0].cnt}`)
}

// ─── 主函数 ─────────────────────────────────────────────────

async function main() {
  const args = process.argv.slice(2)
  const dryRun = args.includes('--dry-run')
  const verifyOnly = args.includes('--verify')

  console.log('=== 充值卡余额迁移 ===')
  console.log(`模式: ${dryRun ? 'DRY-RUN' : verifyOnly ? '仅验证' : '正式执行'}\n`)

  const pgPool = new Pool(PG_CONFIG)

  try {
    await pgPool.query('SELECT 1')
    console.log('✓ PostgreSQL 连接成功\n')

    if (verifyOnly) {
      await verify(pgPool)
      return
    }

    // Step 1: 查询
    const items = await queryPrepaidItems(pgPool)

    // Step 2: 生成
    const cards = generateCards(items)

    if (cards.length === 0) {
      log('没有可导入的充值卡')
      return
    }

    // Step 3: 写入
    await upsertCards(pgPool, cards, dryRun)

    // Step 4: 验证
    if (!dryRun) {
      await verify(pgPool)
    }

    console.log(`\n✓ ${dryRun ? '预览完成' : '迁移完成!'}`)
  } catch (err) {
    console.error('\n✗ 失败:', err.message)
    console.error(err.stack)
    process.exit(1)
  } finally {
    await pgPool.end()
  }
}

main()
