#!/usr/bin/env node

/**
 * 生产数据修复（第三轮）：把「不记入消耗」「录错了」两种服务单备注收敛为寄存单退款专用标准备注，
 * 并同步作废这两张单的有效服务提成。
 *
 * 与前两轮（20260824 / 20260907）同构，但有一处**刻意的差异**，见下文「到店积分」。
 *
 * 副作用口径：
 *   1. service_orders.remark        → 标准备注（下游 29 处消耗业绩过滤 + client 服务记录列表隐藏自动生效）
 *   2. service_orders.commission_status → '已分配'（本批两张本就是，no-op；保持与前两轮同语义）
 *   3. service_commissions           → is_void=true（标记退款单后两端 save 会拒绝再分配，须先结清历史记录）
 *   4. operation_logs                → 逐单审计 + 批次汇总
 *   疗程卡次数**不回滚**：退款核销本就是「真扣次数、假消耗」，这正是本备注要表达的语义。
 *
 * ⚠️ 到店积分：本批次应冲销 0 笔，脚本对此做 fail-closed 断言而**不实现冲销**。
 *   候选单命中 1 笔到店积分（20 分），但该顾客同日另有一张有效售后服务单
 *   （HLD-WX-2609140045，含正价项目），按 visit-points 发放口径该积分本就该发，故保留。
 *   之所以不再带冲销实现：`point_batches`（积分批次，可用余额的真实来源）在本库已启用，
 *   而前两轮的冲销只扣了 client_wechat_users.points_balance、**没有同步扣减
 *   point_batches.remaining_amount**，留下了 6 笔批次口径的缺口（batch 547/585/796/1344/1576 等）。
 *   若将来候选集变化导致确有可冲销积分，必须先决定批次侧怎么扣，再动手——
 *   所以这里让脚本直接失败，而不是沿用一份已知有缺口的实现。
 *
 * 默认 DRY-RUN：事务内跑完整修复 + 后置断言，最后 ROLLBACK。
 *
 *   node db/scripts/repair-deposit-refund-service-remarks-20260921.js
 *   node db/scripts/repair-deposit-refund-service-remarks-20260921.js \
 *     --apply --confirm-prod=repair-deposit-refund-service-remarks-20260921
 *
 * 连接串从 envs/prod.env 的 ADMIN_DATABASE_URL 读取，经权威实现校验后再断言必须是 prod。
 */

const fs = require('fs')
const path = require('path')
const { Client } = require('pg')
const { isAllowedDbTarget, OVERRIDE_KEYS: DB_OVERRIDE_KEYS } = require('./_lib/assert-db-target')

const BATCH_ID = 'repair-deposit-refund-service-remarks-20260921'
const CONFIRM_TOKEN = `--confirm-prod=${BATCH_ID}`
const APPLY = process.argv.includes('--apply')
const CONFIRMED = process.argv.includes(CONFIRM_TOKEN)

/** 数据契约常量：与三端副本逐字节一致（半角空格 + em-dash + 全角逗号），勿改写 */
const TARGET_REMARK = '寄存单退款专用 — 老系统寄存疗程卡退款核销，不计消耗业绩'
const LEGACY_REMARKS = ['不记入消耗', '录错了']

const EXPECTED = {
  candidateOrders: 2,
  existingStandardOrders: 46,
  sessions: 35,
  consumeAmount: 5680.0,
  activeCommissionRows: 26,
  activeCommissionAmount: 53.6,
  matchedVisitPointRows: 1,
  matchedVisitPoints: 20,
  /** 见文件头「到店积分」：本批次必须为 0，否则停下重新评估 point_batches */
  reversibleVisitPointRows: 0,
}

const COMMISSION_VOID_REASON = `${BATCH_ID}: 历史寄存错误服务单提成作废`
const AUDIT_ACTION = 'service.repairDepositRefundRemark'
const SUMMARY_ACTION = 'datafix.repairDepositRefundServiceRemarks'

function log(message) {
  console.log(`[DEPOSIT-REFUND-REMARK-REPAIR] ${new Date().toISOString()} ${message}`)
}

function assert(condition, message) {
  if (!condition) throw new Error(`前置/后置断言失败：${message}`)
}

function number(value) {
  return Number(value || 0)
}

function money(value) {
  return Math.round(number(value) * 100) / 100
}

function loadProdUrl() {
  const envPath = path.resolve(__dirname, '../../envs/prod.env')
  const raw = fs.readFileSync(envPath, 'utf8')
  const line = raw.split(/\r?\n/).find((x) => x.startsWith('ADMIN_DATABASE_URL='))
  if (!line) {
    console.error('FATAL: envs/prod.env 缺少 ADMIN_DATABASE_URL')
    process.exit(1)
  }
  const url = line.slice('ADMIN_DATABASE_URL='.length).replace(/^['"]|['"]$/g, '')

  // 权威实现先挡掉 query 覆盖与白名单外目标（dev/prod 都放行）……
  if (!isAllowedDbTarget(url)) {
    const hit = (() => {
      try {
        const parsed = new URL(url)
        return DB_OVERRIDE_KEYS.filter((k) => parsed.searchParams.has(k))
      } catch {
        return []
      }
    })()
    console.error('FATAL: ADMIN_DATABASE_URL 不在业务库白名单内，拒绝执行')
    if (hit.length) console.error(`  （query 参数 ${hit.join(', ')} 会覆盖连接目标）`)
    process.exit(1)
  }
  // ……本脚本只修生产数据，再单独收紧到 prod。
  const parsed = new URL(url)
  if (parsed.hostname !== '118.178.196.26') {
    console.error('FATAL: 本脚本仅允许生产库 118.178.196.26:5433/fengyu_wxapp')
    process.exit(1)
  }
  return url
}

async function assertShape(client) {
  const { rows } = await client.query(
    `SELECT to_regclass('public.service_orders')::text AS so,
            to_regclass('public.service_items')::text AS si,
            to_regclass('public.service_commissions')::text AS sc,
            to_regclass('public.point_transactions')::text AS pt,
            to_regclass('public.operation_logs')::text AS ol`,
  )
  const row = rows[0]
  assert(row.so && row.si && row.sc && row.pt && row.ol, '生产库缺少本次修复所需表')
}

async function loadCandidates(client) {
  const { rows } = await client.query(
    `SELECT service_order_id, status, service_order_type, client_user_id,
            service_date, commission_status, remark
       FROM service_orders
      WHERE remark = ANY($1::text[])
      ORDER BY service_order_id
      FOR UPDATE`,
    [LEGACY_REMARKS],
  )
  return rows
}

/**
 * 命中候选单「顾客 + 服务日」的到店积分，并判断同日是否还有其它有效售后服务单。
 * 判定条件与 visit-points.js 的 isVisitPointsEligible 一致（售后 + 已完成 + 非退款备注 + 有正价项目）。
 */
async function loadVisitPoints(client, candidateIds) {
  const { rows } = await client.query(
    `WITH candidate_orders AS (
       SELECT client_user_id, service_date
         FROM service_orders
        WHERE service_order_id = ANY($1::varchar[])
     ), matched AS (
       SELECT DISTINCT pt.id, pt.user_id, pt.amount, pt.external_ref, c.service_date
         FROM candidate_orders c
         JOIN point_transactions pt
           ON pt.external_ref = 'visit-points:' || c.client_user_id || ':' || c.service_date::text
     )
     SELECT m.*,
            EXISTS (
              SELECT 1
                FROM service_orders o
               WHERE o.client_user_id = m.user_id
                 AND o.service_date = m.service_date
                 AND NOT (o.service_order_id = ANY($1::varchar[]))
                 AND o.status = '已完成'
                 AND o.service_order_type = '售后'
                 AND o.remark IS DISTINCT FROM $2
                 AND EXISTS (
                   SELECT 1 FROM service_items i
                    WHERE i.service_order_id = o.service_order_id
                      AND i.unit_real_price::numeric > 0
                 )
            ) AS has_other_eligible_service
       FROM matched m
      ORDER BY m.id`,
    [candidateIds, TARGET_REMARK],
  )
  return rows
}

async function applyRepair(client, candidates) {
  const candidateIds = candidates.map((row) => row.service_order_id)
  const oldRemarkById = new Map(candidates.map((row) => [row.service_order_id, row.remark]))

  const remarkUpdate = await client.query(
    `UPDATE service_orders
        SET remark = $1, commission_status = '已分配', updated_at = NOW()
      WHERE service_order_id = ANY($2::varchar[])
        AND remark = ANY($3::text[])
      RETURNING service_order_id`,
    [TARGET_REMARK, candidateIds, LEGACY_REMARKS],
  )
  assert(
    remarkUpdate.rowCount === EXPECTED.candidateOrders,
    `服务单备注实际更新 ${remarkUpdate.rowCount} 张，不是 ${EXPECTED.candidateOrders} 张`,
  )

  const commissionUpdate = await client.query(
    `UPDATE service_commissions sc
        SET is_void = true, voided_at = NOW(), voided_reason = $1, updated_at = NOW()
       FROM service_items sit
      WHERE sit.service_item_id = sc.service_item_id
        AND sit.service_order_id = ANY($2::varchar[])
        AND sc.is_void = false
      RETURNING sc.id, sit.service_order_id, sc.commission_amount`,
    [COMMISSION_VOID_REASON, candidateIds],
  )
  assert(
    commissionUpdate.rowCount === EXPECTED.activeCommissionRows,
    `服务提成实际作废 ${commissionUpdate.rowCount} 条，不是 ${EXPECTED.activeCommissionRows} 条`,
  )

  const commissionByOrder = new Map()
  for (const row of commissionUpdate.rows) {
    const current = commissionByOrder.get(row.service_order_id) || { rows: 0, amount: 0 }
    current.rows += 1
    current.amount = money(current.amount + number(row.commission_amount))
    commissionByOrder.set(row.service_order_id, current)
  }

  for (const candidate of candidates) {
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
      visitPoints: { outcome: 'none-reversed', note: '同日另有有效售后服务单，到店积分按发放口径保留' },
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
    reversedVisitPointRows: 0,
    keptValidVisitPointRows: EXPECTED.matchedVisitPointRows,
  }
  const summaryInsert = await client.query(
    `INSERT INTO operation_logs (action, target_type, target_id, detail, source, created_at)
     SELECT $1, 'datafix_batch', $2, $3::jsonb, 'maintenance', NOW()
      WHERE NOT EXISTS (SELECT 1 FROM operation_logs WHERE action = $1 AND target_id = $2)`,
    [SUMMARY_ACTION, BATCH_ID, JSON.stringify(summary)],
  )
  assert(summaryInsert.rowCount === 1, '未写入唯一批次汇总审计日志')
}

async function assertFinalState(client, candidateIds) {
  const { rows } = await client.query(
    `SELECT
       (SELECT COUNT(*)::int FROM service_orders WHERE remark = ANY($1::text[])) AS legacy_orders,
       (SELECT COUNT(*)::int FROM service_orders WHERE remark = $2) AS standard_orders,
       (SELECT COUNT(*)::int
          FROM service_orders
         WHERE service_order_id = ANY($3::varchar[])
           AND remark = $2 AND status = '已完成' AND commission_status = '已分配') AS repaired_orders,
       (SELECT COUNT(*)::int
          FROM service_commissions sc
          JOIN service_items sit ON sit.service_item_id = sc.service_item_id
         WHERE sit.service_order_id = ANY($3::varchar[]) AND sc.is_void = false) AS active_commissions,
       (SELECT COUNT(*)::int FROM service_commissions WHERE voided_reason = $4) AS marked_commissions,
       (SELECT COALESCE(SUM(commission_amount::numeric), 0)::numeric(14,2)
          FROM service_commissions WHERE voided_reason = $4) AS marked_commission_amount,
       (SELECT COUNT(*)::int FROM operation_logs
         WHERE action = $5 AND detail->>'batchId' = $6) AS audit_rows`,
    [LEGACY_REMARKS, TARGET_REMARK, candidateIds, COMMISSION_VOID_REASON, AUDIT_ACTION, BATCH_ID],
  )
  const row = rows[0]
  assert(number(row.legacy_orders) === 0, '仍有旧备注服务单')
  assert(
    number(row.standard_orders) === EXPECTED.existingStandardOrders + EXPECTED.candidateOrders,
    `标准备注服务单总数为 ${row.standard_orders}，不是 ${EXPECTED.existingStandardOrders + EXPECTED.candidateOrders}`,
  )
  assert(number(row.repaired_orders) === EXPECTED.candidateOrders, '目标服务单状态/提成状态/备注不正确')
  assert(number(row.active_commissions) === 0, '目标服务单仍有有效服务提成')
  assert(
    number(row.marked_commissions) === EXPECTED.activeCommissionRows,
    `带本次修复标记的提成为 ${row.marked_commissions} 条，不是 ${EXPECTED.activeCommissionRows} 条`,
  )
  assert(
    money(row.marked_commission_amount) === EXPECTED.activeCommissionAmount,
    `带本次修复标记的提成金额为 ${row.marked_commission_amount}，不是 ${EXPECTED.activeCommissionAmount}`,
  )
  assert(number(row.audit_rows) === EXPECTED.candidateOrders, '逐服务单审计日志数量不正确')
}

async function main() {
  const databaseUrl = loadProdUrl()
  if (APPLY && !CONFIRMED) {
    console.error(`FATAL: APPLY 必须追加 ${CONFIRM_TOKEN}`)
    process.exit(1)
  }
  log(`目标库: 118.178.196.26:5433/fengyu_wxapp`)
  log(`模式: ${APPLY ? 'APPLY（提交）' : 'DRY-RUN（完整执行后回滚）'}`)

  const client = new Client({ connectionString: databaseUrl })
  await client.connect()
  try {
    await client.query('BEGIN')
    await client.query(`SELECT pg_advisory_xact_lock(hashtext('${BATCH_ID}'))`)
    await assertShape(client)

    const candidates = await loadCandidates(client)
    if (candidates.length === 0) {
      const { rows } = await client.query(
        `SELECT target_id FROM operation_logs
          WHERE action = $1 AND source = 'maintenance' AND detail->>'batchId' = $2
          ORDER BY target_id`,
        [AUDIT_ACTION, BATCH_ID],
      )
      assert(
        rows.length === EXPECTED.candidateOrders,
        `旧备注已无命中，但本批次审计记录是 ${rows.length} 条而非 ${EXPECTED.candidateOrders} 条`,
      )
      await assertFinalState(client, rows.map((r) => r.target_id))
      log('修复已完成且后置断言仍通过，无需重复写入')
      await client.query('ROLLBACK')
      return
    }

    assert(
      candidates.length === EXPECTED.candidateOrders,
      `旧备注命中 ${candidates.length} 张，不是 ${EXPECTED.candidateOrders} 张`,
    )
    assert(candidates.every((row) => row.status === '已完成'), '目标服务单并非全部已完成')

    const candidateIds = candidates.map((row) => row.service_order_id)

    const standardBefore = await client.query(
      'SELECT COUNT(*)::int AS count FROM service_orders WHERE remark = $1',
      [TARGET_REMARK],
    )
    assert(
      number(standardBefore.rows[0].count) === EXPECTED.existingStandardOrders,
      `已有标准备注服务单为 ${standardBefore.rows[0].count} 张，不是 ${EXPECTED.existingStandardOrders} 张`,
    )

    const impact = await client.query(
      `SELECT COALESCE(SUM(session_used), 0)::int AS sessions,
              COALESCE(SUM(unit_real_price::numeric * session_used), 0)::numeric(14,2) AS consume_amount
         FROM service_items WHERE service_order_id = ANY($1::varchar[])`,
      [candidateIds],
    )
    assert(
      number(impact.rows[0].sessions) === EXPECTED.sessions,
      `目标服务次数为 ${impact.rows[0].sessions}，不是 ${EXPECTED.sessions}`,
    )
    assert(
      money(impact.rows[0].consume_amount) === EXPECTED.consumeAmount,
      `目标消耗金额为 ${impact.rows[0].consume_amount}，不是 ${EXPECTED.consumeAmount}`,
    )

    const commissionImpact = await client.query(
      `SELECT COUNT(*)::int AS rows,
              COALESCE(SUM(sc.commission_amount::numeric), 0)::numeric(14,2) AS amount
         FROM service_commissions sc
         JOIN service_items sit ON sit.service_item_id = sc.service_item_id
        WHERE sit.service_order_id = ANY($1::varchar[]) AND sc.is_void = false`,
      [candidateIds],
    )
    assert(
      number(commissionImpact.rows[0].rows) === EXPECTED.activeCommissionRows,
      `有效提成为 ${commissionImpact.rows[0].rows} 条，不是 ${EXPECTED.activeCommissionRows} 条`,
    )
    assert(
      money(commissionImpact.rows[0].amount) === EXPECTED.activeCommissionAmount,
      `有效提成金额为 ${commissionImpact.rows[0].amount}，不是 ${EXPECTED.activeCommissionAmount}`,
    )

    const visitPoints = await loadVisitPoints(client, candidateIds)
    const matchedTotal = visitPoints.reduce((sum, row) => sum + number(row.amount), 0)
    const reversible = visitPoints.filter((row) => !row.has_other_eligible_service)
    assert(
      visitPoints.length === EXPECTED.matchedVisitPointRows,
      `候选到店积分为 ${visitPoints.length} 笔，不是 ${EXPECTED.matchedVisitPointRows} 笔`,
    )
    assert(
      matchedTotal === EXPECTED.matchedVisitPoints,
      `候选到店积分合计 ${matchedTotal} 分，不是 ${EXPECTED.matchedVisitPoints} 分`,
    )
    // fail-closed：本脚本不带积分冲销实现，见文件头「到店积分」
    assert(
      reversible.length === EXPECTED.reversibleVisitPointRows,
      `应冲销到店积分为 ${reversible.length} 笔（期望 0）——本脚本不含冲销实现，` +
        '且前两轮的冲销未扣减 point_batches.remaining_amount，须先决定批次侧口径再执行',
    )

    log(`前置核对通过：${candidates.length} 张服务单 / ${impact.rows[0].sessions} 次 / ${impact.rows[0].consume_amount} 元消耗`)
    log(`待作废提成：${commissionImpact.rows[0].rows} 条 / ${commissionImpact.rows[0].amount} 元`)
    log(`到店积分：命中 ${visitPoints.length} 笔 ${matchedTotal} 分，全部保留（同日另有有效售后服务单）`)

    await applyRepair(client, candidates)
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
    console.error('[DEPOSIT-REFUND-REMARK-REPAIR] 修复失败，已回滚：', error.message)
    process.exitCode = 1
  } finally {
    await client.end()
  }
}

main().catch((error) => {
  console.error('FATAL:', error)
  process.exit(1)
})
