#!/usr/bin/env node

/**
 * 生产数据修复：把 12 种历史「寄存录错/非服务」服务单备注收敛为标准备注，
 * 同步软作废历史服务提成，并冲销仅由错误服务单触发的到店积分。
 *
 * 默认 DRY-RUN：在事务内执行完整修复和后置断言，最后 ROLLBACK。
 * APPLY 仅允许显式连接生产库，并要求确认令牌：
 *
 *   DATABASE_URL="postgresql://***@118.178.196.26:5433/fengyu_wxapp" \
 *     node db/scripts/repair-deposit-refund-service-remarks-20260824.js
 *
 *   DATABASE_URL="postgresql://***@118.178.196.26:5433/fengyu_wxapp" \
 *     node db/scripts/repair-deposit-refund-service-remarks-20260824.js \
 *       --apply --confirm-prod=repair-deposit-refund-service-remarks-20260824
 */

const { Client } = require('pg')
const { OVERRIDE_KEYS: DB_OVERRIDE_KEYS } = require('./_lib/assert-db-target')

const BATCH_ID = 'repair-deposit-refund-service-remarks-20260824'
const CONFIRM_TOKEN = `--confirm-prod=${BATCH_ID}`
const APPLY = process.argv.includes('--apply')
const CONFIRMED = process.argv.includes(CONFIRM_TOKEN)

const TARGET_REMARK = '寄存单退款专用 — 老系统寄存疗程卡退款核销，不计消耗业绩'
const LEGACY_REMARKS = [
  '已退款34元',
  '审核完出错了重新录',
  '审核错了，重新录',
  '录错非划卡',
  '寄存录错了 未服务',
  '寄存金额填错，不算服务消耗',
  '寄存单金额入错了',
  '寄存错误非服务',
  '寄存错误，划卡纠错。不计算消耗',
  '寄存错误，非服务',
  '非正常护理，寄存多了1次 划掉多余次数。',
  '多一次划了，不算消耗',
]

const EXPECTED = {
  candidateOrders: 14,
  existingStandardOrders: 6,
  assignedCommissionStatusOrders: 12,
  nullCommissionStatusOrders: 2,
  sessions: 936,
  consumeAmount: 383224.89,
  activeCommissionRows: 437,
  activeCommissionAmount: 34920.50,
  matchedVisitPointRows: 6,
  matchedVisitPoints: 120,
  reversibleVisitPointRows: 3,
  reversibleVisitPoints: 60,
}

const COMMISSION_VOID_REASON = `${BATCH_ID}: 历史寄存错误服务单提成作废`
const AUDIT_ACTION = 'service.repairDepositRefundRemark'
const SUMMARY_ACTION = 'datafix.repairDepositRefundServiceRemarks'
const POINT_REVERSAL_PREFIX = `${BATCH_ID}:visit-points:`

function log(message) {
  console.log(`[DEPOSIT-REFUND-REMARK-REPAIR] ${new Date().toISOString()} ${message}`)
}

function fail(message) {
  throw new Error(`前置/后置断言失败：${message}`)
}

function assert(condition, message) {
  if (!condition) fail(message)
}

function number(value) {
  return Number(value || 0)
}

function money(value) {
  return Math.round(number(value) * 100) / 100
}

function dateOnly(value) {
  if (value instanceof Date) {
    return value.toLocaleDateString('sv-SE', { timeZone: 'Asia/Shanghai' })
  }
  return String(value).slice(0, 10)
}

function maskedUrl(raw) {
  return raw.replace(/:[^:@/]+@/, ':***@')
}

async function assertProductionShape(client) {
  const result = await client.query(
    `SELECT
       to_regclass('public.point_batches')::text AS point_batches,
       to_regclass('public.service_orders')::text AS service_orders,
       to_regclass('public.service_commissions')::text AS service_commissions,
       to_regclass('public.point_transactions')::text AS point_transactions,
       to_regclass('public.operation_logs')::text AS operation_logs`,
  )
  const row = result.rows[0]
  assert(row.service_orders && row.service_commissions && row.point_transactions && row.operation_logs,
    '生产库缺少本次修复所需表')
  assert(!row.point_batches,
    '生产库已出现 point_batches，积分模型已变化，必须重新评估冲销方案')
}

async function loadExistingStandardCount(client) {
  const result = await client.query(
    'SELECT COUNT(*)::int AS count FROM service_orders WHERE remark = $1',
    [TARGET_REMARK],
  )
  return number(result.rows[0]?.count)
}

async function loadCandidates(client) {
  const result = await client.query(
    `SELECT service_order_id, status, service_order_type, client_user_id,
            service_date, commission_status, remark
       FROM service_orders
      WHERE remark = ANY($1::text[])
      ORDER BY service_order_id
      FOR UPDATE`,
    [LEGACY_REMARKS],
  )
  return result.rows
}

async function loadAppliedTargetIds(client) {
  const result = await client.query(
    `SELECT target_id
       FROM operation_logs
      WHERE action = $1
        AND source = 'maintenance'
        AND detail->>'batchId' = $2
      ORDER BY target_id`,
    [AUDIT_ACTION, BATCH_ID],
  )
  return result.rows.map((row) => row.target_id)
}

async function loadCandidateImpact(client, candidateIds) {
  const result = await client.query(
    `SELECT
       COALESCE(SUM(sit.session_used), 0)::int AS sessions,
       COALESCE(SUM(sit.unit_real_price::numeric * sit.session_used), 0)::numeric(14,2) AS consume_amount
     FROM service_items sit
     WHERE sit.service_order_id = ANY($1::varchar[])`,
    [candidateIds],
  )
  return result.rows[0]
}

async function loadActiveCommissionImpact(client, candidateIds) {
  const result = await client.query(
    `SELECT COUNT(*)::int AS rows,
            COALESCE(SUM(sc.commission_amount::numeric), 0)::numeric(14,2) AS amount
       FROM service_commissions sc
       JOIN service_items sit ON sit.service_item_id = sc.service_item_id
      WHERE sit.service_order_id = ANY($1::varchar[])
        AND sc.is_void = false`,
    [candidateIds],
  )
  return result.rows[0]
}

async function loadVisitPointCandidates(client, candidateIds) {
  const result = await client.query(
    `WITH candidate_orders AS (
       SELECT service_order_id, client_user_id, service_date
         FROM service_orders
        WHERE service_order_id = ANY($1::varchar[])
     ), matched AS (
       SELECT DISTINCT pt.id, pt.user_id, pt.amount, pt.external_ref,
              c.service_date
         FROM candidate_orders c
         JOIN point_transactions pt
           ON pt.external_ref = 'visit-points:' || c.client_user_id || ':' || c.service_date::text
     )
     SELECT m.id, m.user_id, m.amount, m.external_ref, m.service_date,
            EXISTS (
              SELECT 1
                FROM service_orders other_so
               WHERE other_so.client_user_id = m.user_id
                 AND other_so.service_date = m.service_date
                 AND NOT (other_so.service_order_id = ANY($1::varchar[]))
                 AND other_so.status = '已完成'
                 AND other_so.service_order_type = '售后'
                 AND other_so.remark IS DISTINCT FROM $2
                 AND EXISTS (
                   SELECT 1
                     FROM service_items other_sit
                    WHERE other_sit.service_order_id = other_so.service_order_id
                      AND other_sit.unit_real_price::numeric > 0
                 )
            ) AS has_other_eligible_service
       FROM matched m
      ORDER BY m.id`,
    [candidateIds, TARGET_REMARK],
  )

  return result.rows
}

async function lockAndAssertPointUsers(client, reversiblePoints) {
  const pointsByUser = new Map()
  for (const point of reversiblePoints) {
    pointsByUser.set(point.user_id, (pointsByUser.get(point.user_id) || 0) + number(point.amount))
  }
  const userIds = [...pointsByUser.keys()]
  const result = await client.query(
    `SELECT c.user_id, c.points_balance,
            COALESCE((
              SELECT SUM(pt.amount) FROM point_transactions pt WHERE pt.user_id = c.user_id
            ), 0)::bigint AS ledger_total
       FROM client_wechat_users c
      WHERE c.user_id = ANY($1::text[])
      ORDER BY c.user_id
      FOR UPDATE`,
    [userIds],
  )
  assert(result.rows.length === userIds.length, '待冲销积分顾客记录不完整')
  for (const row of result.rows) {
    const balance = number(row.points_balance)
    const ledger = number(row.ledger_total)
    const reversal = pointsByUser.get(row.user_id)
    assert(balance === ledger, `顾客 ${row.user_id} 的积分余额与流水不一致`)
    assert(balance >= reversal, `顾客 ${row.user_id} 的积分余额不足以冲销 ${reversal} 分`)
  }
  return pointsByUser
}

async function applyRepair(client, candidates, visitPoints, pointsByUser) {
  const candidateIds = candidates.map((row) => row.service_order_id)
  const oldRemarkById = new Map(candidates.map((row) => [row.service_order_id, row.remark]))

  const remarkUpdate = await client.query(
    `UPDATE service_orders
        SET remark = $1,
            commission_status = '已分配',
            updated_at = NOW()
      WHERE service_order_id = ANY($2::varchar[])
        AND remark = ANY($3::text[])
      RETURNING service_order_id`,
    [TARGET_REMARK, candidateIds, LEGACY_REMARKS],
  )
  assert(remarkUpdate.rowCount === EXPECTED.candidateOrders,
    `服务单备注实际更新 ${remarkUpdate.rowCount} 张，不是 ${EXPECTED.candidateOrders} 张`)

  const commissionUpdate = await client.query(
    `UPDATE service_commissions sc
        SET is_void = true,
            voided_at = NOW(),
            voided_reason = $1,
            updated_at = NOW()
       FROM service_items sit
      WHERE sit.service_item_id = sc.service_item_id
        AND sit.service_order_id = ANY($2::varchar[])
        AND sc.is_void = false
      RETURNING sc.id, sit.service_order_id, sc.commission_amount`,
    [COMMISSION_VOID_REASON, candidateIds],
  )
  assert(commissionUpdate.rowCount === EXPECTED.activeCommissionRows,
    `服务提成实际作废 ${commissionUpdate.rowCount} 条，不是 ${EXPECTED.activeCommissionRows} 条`)

  const commissionByOrder = new Map()
  for (const row of commissionUpdate.rows) {
    const current = commissionByOrder.get(row.service_order_id) || { rows: 0, amount: 0 }
    current.rows += 1
    current.amount = money(current.amount + number(row.commission_amount))
    commissionByOrder.set(row.service_order_id, current)
  }

  const reversiblePoints = visitPoints.filter((row) => !row.has_other_eligible_service)
  for (const point of reversiblePoints) {
    const externalRef = `${POINT_REVERSAL_PREFIX}${point.id}`
    const insert = await client.query(
      `INSERT INTO point_transactions
         (user_id, type, amount, ref_order_id, external_ref, created_at)
       VALUES ($1, '消费冲销', $2, NULL, $3, NOW())
       ON CONFLICT (external_ref) WHERE external_ref IS NOT NULL DO NOTHING
       RETURNING id`,
      [point.user_id, -number(point.amount), externalRef],
    )
    assert(insert.rowCount === 1, `积分流水 ${point.id} 未写入唯一冲销记录`)
  }

  for (const [userId, reversalAmount] of pointsByUser.entries()) {
    const update = await client.query(
      `UPDATE client_wechat_users
          SET points_balance = points_balance - $1,
              points_updated_at = NOW(),
              updated_at = NOW()
        WHERE user_id = $2
          AND points_balance >= $1
        RETURNING points_balance`,
      [reversalAmount, userId],
    )
    assert(update.rowCount === 1, `顾客 ${userId} 积分余额扣减失败`)
  }

  for (const candidate of candidates) {
    const visitExternalRef = candidate.client_user_id
      ? `visit-points:${candidate.client_user_id}:${dateOnly(candidate.service_date)}`
      : null
    const visitPoint = visitPoints.find((row) => row.external_ref === visitExternalRef) || null
    const commission = commissionByOrder.get(candidate.service_order_id) || { rows: 0, amount: 0 }
    const detail = {
      _v: 1,
      batchId: BATCH_ID,
      reason: '历史寄存错误/非服务服务单收敛为寄存单退款专用口径',
      before: { remark: oldRemarkById.get(candidate.service_order_id) },
      after: { remark: TARGET_REMARK },
      commission: {
        voidedRows: commission.rows,
        voidedAmount: commission.amount,
        commissionStatusBefore: candidate.commission_status,
        commissionStatusAfter: '已分配',
      },
      visitPoints: visitPoint
        ? {
            originalTransactionId: number(visitPoint.id),
            amount: number(visitPoint.amount),
            outcome: visitPoint.has_other_eligible_service ? 'kept-valid-same-day-visit' : 'reversed',
          }
        : { outcome: 'none' },
    }
    const auditInsert = await client.query(
      `INSERT INTO operation_logs
         (operator_employee_id, operator_name, operator_role, org_node_id, org_node_name,
          action, target_type, target_id, detail, source, created_at)
       SELECT NULL, NULL, NULL, NULL, NULL,
              $1, 'service_order', $2, $3::jsonb, 'maintenance', NOW()
        WHERE NOT EXISTS (
          SELECT 1 FROM operation_logs
           WHERE action = $1 AND target_id = $2 AND detail->>'batchId' = $4
        )`,
      [AUDIT_ACTION, candidate.service_order_id, JSON.stringify(detail), BATCH_ID],
    )
    assert(auditInsert.rowCount === 1, `服务单 ${candidate.service_order_id} 未写入唯一修复审计日志`)
  }

  const summary = {
    _v: 1,
    batchId: BATCH_ID,
    targetRemark: TARGET_REMARK,
    serviceOrders: EXPECTED.candidateOrders,
    voidedCommissionRows: EXPECTED.activeCommissionRows,
    voidedCommissionAmount: EXPECTED.activeCommissionAmount,
    reversedVisitPointRows: EXPECTED.reversibleVisitPointRows,
    reversedVisitPoints: EXPECTED.reversibleVisitPoints,
    keptValidVisitPointRows: EXPECTED.matchedVisitPointRows - EXPECTED.reversibleVisitPointRows,
  }
  const summaryInsert = await client.query(
    `INSERT INTO operation_logs
       (action, target_type, target_id, detail, source, created_at)
     SELECT $1, 'datafix_batch', $2, $3::jsonb, 'maintenance', NOW()
      WHERE NOT EXISTS (
        SELECT 1 FROM operation_logs WHERE action = $1 AND target_id = $2
      )`,
    [SUMMARY_ACTION, BATCH_ID, JSON.stringify(summary)],
  )
  assert(summaryInsert.rowCount === 1, '未写入唯一批次汇总审计日志')
}

async function assertFinalState(client, candidateIds) {
  const result = await client.query(
    `SELECT
       (SELECT COUNT(*)::int FROM service_orders WHERE remark = ANY($1::text[])) AS legacy_orders,
       (SELECT COUNT(*)::int FROM service_orders WHERE remark = $2) AS standard_orders,
       (SELECT COUNT(*)::int
          FROM service_orders
         WHERE service_order_id = ANY($3::varchar[])
           AND remark = $2
           AND status = '已完成'
           AND commission_status = '已分配') AS repaired_orders,
       (SELECT COUNT(*)::int
          FROM service_commissions sc
          JOIN service_items sit ON sit.service_item_id = sc.service_item_id
         WHERE sit.service_order_id = ANY($3::varchar[])
           AND sc.is_void = false) AS active_commissions,
       (SELECT COUNT(*)::int
          FROM service_commissions
         WHERE voided_reason = $4) AS marked_commissions,
       (SELECT COALESCE(SUM(commission_amount::numeric), 0)::numeric(14,2)
          FROM service_commissions
         WHERE voided_reason = $4) AS marked_commission_amount,
       (SELECT COUNT(*)::int
          FROM point_transactions
         WHERE external_ref LIKE $5) AS reversal_rows,
       (SELECT COALESCE(-SUM(amount), 0)::bigint
          FROM point_transactions
         WHERE external_ref LIKE $5) AS reversal_points,
       (SELECT COUNT(*)::int
          FROM operation_logs
         WHERE action = $6 AND detail->>'batchId' = $7) AS audit_rows`,
    [LEGACY_REMARKS, TARGET_REMARK, candidateIds, COMMISSION_VOID_REASON,
      `${POINT_REVERSAL_PREFIX}%`, AUDIT_ACTION, BATCH_ID],
  )
  const row = result.rows[0]
  assert(number(row.legacy_orders) === 0, '仍有旧备注服务单')
  assert(number(row.standard_orders) === EXPECTED.existingStandardOrders + EXPECTED.candidateOrders,
    '标准备注服务单总数不正确')
  assert(number(row.repaired_orders) === EXPECTED.candidateOrders,
    '目标服务单状态、提成状态或标准备注不正确')
  assert(number(row.active_commissions) === 0, '目标服务单仍有有效服务提成')
  assert(number(row.marked_commissions) === EXPECTED.activeCommissionRows,
    '带本次修复标记的提成数量不正确')
  assert(money(row.marked_commission_amount) === EXPECTED.activeCommissionAmount,
    '带本次修复标记的提成金额不正确')
  assert(number(row.reversal_rows) === EXPECTED.reversibleVisitPointRows,
    '积分冲销流水数量不正确')
  assert(number(row.reversal_points) === EXPECTED.reversibleVisitPoints,
    '积分冲销总额不正确')
  assert(number(row.audit_rows) === EXPECTED.candidateOrders, '逐服务单审计日志数量不正确')

  const balanceCheck = await client.query(
    `SELECT COUNT(*)::int AS mismatches
       FROM client_wechat_users c
      WHERE c.user_id IN (
        SELECT user_id FROM point_transactions WHERE external_ref LIKE $1
      )
        AND (
          c.points_balance < 0
          OR c.points_balance IS DISTINCT FROM COALESCE((
            SELECT SUM(pt.amount) FROM point_transactions pt WHERE pt.user_id = c.user_id
          ), 0)
        )`,
    [`${POINT_REVERSAL_PREFIX}%`],
  )
  assert(number(balanceCheck.rows[0]?.mismatches) === 0,
    '冲销积分后的顾客余额出现负数或与流水不一致')
}

async function main() {
  const databaseUrl = process.env.DATABASE_URL
  if (!databaseUrl) {
    console.error('FATAL: 必须显式设置 DATABASE_URL')
    process.exit(1)
  }

  const parsed = new URL(databaseUrl)
  // query 参数（含百分号编码形式）优先级高于 URL authority，只比 hostname/port/pathname
  // 会被 `?host=<旧库>` 整个绕过 —— 而本脚本 --apply 直接写生产数据。
  {
    const overriding = DB_OVERRIDE_KEYS.filter((k) => parsed.searchParams.has(k))
    if (overriding.length) {
      console.error(`FATAL: 连接串 query 试图覆盖连接目标（${overriding.join(', ')}），拒绝执行`)
      process.exit(1)
    }
  }

  if (parsed.hostname !== '118.178.196.26' || parsed.port !== '5433' || parsed.pathname !== '/fengyu_wxapp') {
    console.error('FATAL: 本脚本仅允许生产库 118.178.196.26:5433/fengyu_wxapp')
    process.exit(1)
  }
  if (APPLY && !CONFIRMED) {
    console.error(`FATAL: APPLY 必须追加 ${CONFIRM_TOKEN}`)
    process.exit(1)
  }

  log(`目标库: ${maskedUrl(databaseUrl)}`)
  log(`模式: ${APPLY ? 'APPLY（提交）' : 'DRY-RUN（完整执行后回滚）'}`)

  const client = new Client({ connectionString: databaseUrl })
  await client.connect()
  try {
    await client.query('BEGIN')
    await client.query("SELECT pg_advisory_xact_lock(hashtext('repair-deposit-refund-service-remarks-20260824'))")
    await assertProductionShape(client)

    const candidates = await loadCandidates(client)
    if (candidates.length === 0) {
      const appliedTargetIds = await loadAppliedTargetIds(client)
      if (appliedTargetIds.length === EXPECTED.candidateOrders) {
        await assertFinalState(client, appliedTargetIds)
        log('修复已完成且后置断言仍通过，无需重复写入')
        await client.query('ROLLBACK')
        return
      }
      fail('旧备注已无命中，但找不到完整的本批次审计记录')
    }

    assert(candidates.length === EXPECTED.candidateOrders,
      `旧备注命中 ${candidates.length} 张，不是 ${EXPECTED.candidateOrders} 张`)
    assert(candidates.every((row) => row.status === '已完成'), '目标服务单并非全部已完成')
    const assignedStatusOrders = candidates.filter((row) => row.commission_status === '已分配').length
    const nullStatusOrders = candidates.filter((row) => row.commission_status == null).length
    assert(assignedStatusOrders === EXPECTED.assignedCommissionStatusOrders,
      `提成状态为已分配的目标单有 ${assignedStatusOrders} 张，不是 ${EXPECTED.assignedCommissionStatusOrders} 张`)
    assert(nullStatusOrders === EXPECTED.nullCommissionStatusOrders,
      `提成状态为空的目标单有 ${nullStatusOrders} 张，不是 ${EXPECTED.nullCommissionStatusOrders} 张`)

    const existingStandardOrders = await loadExistingStandardCount(client)
    assert(existingStandardOrders === EXPECTED.existingStandardOrders,
      `已有标准备注服务单为 ${existingStandardOrders} 张，不是 ${EXPECTED.existingStandardOrders} 张`)

    const candidateIds = candidates.map((row) => row.service_order_id)
    const impact = await loadCandidateImpact(client, candidateIds)
    assert(number(impact.sessions) === EXPECTED.sessions,
      `目标服务次数为 ${impact.sessions}，不是 ${EXPECTED.sessions}`)
    assert(money(impact.consume_amount) === EXPECTED.consumeAmount,
      `目标消耗金额为 ${impact.consume_amount}，不是 ${EXPECTED.consumeAmount}`)

    const commissionImpact = await loadActiveCommissionImpact(client, candidateIds)
    assert(number(commissionImpact.rows) === EXPECTED.activeCommissionRows,
      `有效提成为 ${commissionImpact.rows} 条，不是 ${EXPECTED.activeCommissionRows} 条`)
    assert(money(commissionImpact.amount) === EXPECTED.activeCommissionAmount,
      `有效提成金额为 ${commissionImpact.amount}，不是 ${EXPECTED.activeCommissionAmount}`)

    const visitPoints = await loadVisitPointCandidates(client, candidateIds)
    const matchedPointTotal = visitPoints.reduce((sum, row) => sum + number(row.amount), 0)
    const reversiblePoints = visitPoints.filter((row) => !row.has_other_eligible_service)
    const reversiblePointTotal = reversiblePoints.reduce((sum, row) => sum + number(row.amount), 0)
    assert(visitPoints.length === EXPECTED.matchedVisitPointRows,
      `候选到店积分为 ${visitPoints.length} 笔，不是 ${EXPECTED.matchedVisitPointRows} 笔`)
    assert(matchedPointTotal === EXPECTED.matchedVisitPoints,
      `候选到店积分合计 ${matchedPointTotal} 分，不是 ${EXPECTED.matchedVisitPoints} 分`)
    assert(reversiblePoints.length === EXPECTED.reversibleVisitPointRows,
      `应冲销到店积分为 ${reversiblePoints.length} 笔，不是 ${EXPECTED.reversibleVisitPointRows} 笔`)
    assert(reversiblePointTotal === EXPECTED.reversibleVisitPoints,
      `应冲销到店积分合计 ${reversiblePointTotal} 分，不是 ${EXPECTED.reversibleVisitPoints} 分`)

    const pointsByUser = await lockAndAssertPointUsers(client, reversiblePoints)
    log(`前置核对通过：${candidates.length} 张服务单 / ${impact.sessions} 次 / ${impact.consume_amount} 元消耗`)
    log(`待作废提成：${commissionImpact.rows} 条 / ${commissionImpact.amount} 元`)
    log(`到店积分：候选 ${visitPoints.length} 笔 ${matchedPointTotal} 分；冲销 ${reversiblePoints.length} 笔 ${reversiblePointTotal} 分；保留 ${visitPoints.length - reversiblePoints.length} 笔`)

    await applyRepair(client, candidates, visitPoints, pointsByUser)
    await assertFinalState(client, candidateIds)

    if (APPLY) {
      await client.query('COMMIT')
      log('生产数据修复已提交，全部后置断言通过 ✓')
    } else {
      await client.query('ROLLBACK')
      log('DRY-RUN 已回滚；所有前置、更新和后置断言均通过')
    }
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {})
    console.error('[DEPOSIT-REFUND-REMARK-REPAIR] 修复失败，已回滚：', error)
    process.exitCode = 1
  } finally {
    await client.end()
  }
}

main().catch((error) => {
  console.error('FATAL:', error)
  process.exit(1)
})
