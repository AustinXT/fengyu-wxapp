#!/usr/bin/env bun
/**
 * sale_orders_pkey / service_orders_pkey 冲突监控（本地模拟生产日志监控）
 *
 * 关联：notes/tickets/archives/2026-05-17-advisory-lock-cross-transaction-window.md §5.3
 *
 * 生产 PG 日志中的 `duplicate key value violates unique constraint "..._pkey"` 错误
 * 落在 PG host 磁盘的 log file 上，本地无 SSH 访问。本脚本用 DB 内可查指标作为
 * 等价代理，无需 PG log file 访问权限：
 *
 *   1. **序号 gap 分析**：扫每日 sale_orders / service_orders，按 `日期前缀+4位序号`
 *      解析，找连续序号中缺失的"洞"。修复前 advisory lock TOCTOU 撞号 → 第二个
 *      INSERT 抛 duplicate key + 整事务 ROLLBACK，该序号不会出现在表里 → 下一个
 *      请求拿到下一个序号 → 留下 gap。修复后 advisory lock 持锁覆盖到 COMMIT，无
 *      并发撞号，理论上无 gap（业务正常 ROLLBACK 也会留 gap，但量级远低于撞号）。
 *
 *   2. **xact_rollback 增量**：`pg_stat_database` 的事务回滚计数。修复前撞号事务
 *      自动 ROLLBACK，rollback/sec 偏高；修复后下降。基线快照 + 等待窗口 + 再次
 *      快照即可看增量。
 *
 * 用法：
 *   bun fengyu-staff/scripts/manual-e2e/monitor-pk-conflicts.mjs           # 默认查最近 30 天
 *   DAYS=7 bun fengyu-staff/scripts/manual-e2e/monitor-pk-conflicts.mjs    # 自定义窗口
 *   ROLLBACK_WAIT=300 bun fengyu-staff/scripts/manual-e2e/monitor-pk-conflicts.mjs  # 5 分钟 rollback 增量采样
 *
 * 生产 PG 日志直接监控命令（需 SSH 到 PG host，本脚本不执行，仅作运维参考）：
 *
 *   # 历史 7 天冲突计数
 *   grep -c 'duplicate key value violates unique constraint "sale_orders_pkey"' /var/log/postgresql/postgresql-*.log
 *   grep -c 'duplicate key value violates unique constraint "service_orders_pkey"' /var/log/postgresql/postgresql-*.log
 *
 *   # 按天分桶
 *   grep 'duplicate key.*sale_orders_pkey' /var/log/postgresql/postgresql-*.log | awk '{print $1}' | sort | uniq -c
 */
import { Pool } from 'pg'

// 连接串必填：不提供默认值，避免忘传时连到已失效的旧地址（见 db/CLAUDE.md）
const PG_CONNECTION_STRING =
  process.env.PG_CONNECTION_STRING || process.env.DATABASE_URL
if (!PG_CONNECTION_STRING) {
  console.error('✗ 必须显式传 PG_CONNECTION_STRING 或 DATABASE_URL（dev=101.34.242.103:5433/fengyu_wxapp / prod=118.178.196.26:5433/fengyu_wxapp）')
  process.exit(1)
}

const DAYS = Number(process.env.DAYS || 30)
const ROLLBACK_WAIT = Number(process.env.ROLLBACK_WAIT || 0) // 0 = 不采样

const pool = new Pool({ connectionString: PG_CONNECTION_STRING, max: 2 })

function rec(s) { console.log(s) }

/**
 * 解析 sale_order_id (FY-XSD-WX-YYMMDD####) 或 service_order_id (HLD-WX-YYMMDD####)
 * 拆出日期串 + 4 位序号
 */
function parseSeq(id, prefix) {
  if (!id.startsWith(prefix)) return null
  const suffix = id.slice(prefix.length) // "YYMMDD####"
  if (!/^\d{10}$/.test(suffix)) return null
  return {
    dateStr: suffix.slice(0, 6),
    seq: parseInt(suffix.slice(6), 10),
  }
}

async function gapAnalysis(table, idColumn, prefix, sinceDate) {
  const rows = await pool.query(
    `SELECT ${idColumn} AS id, created_at FROM ${table}
     WHERE created_at >= $1 AND ${idColumn} LIKE $2
     ORDER BY ${idColumn} ASC`,
    [sinceDate, `${prefix}%`]
  )

  // 按 dateStr 分桶
  const buckets = new Map() // dateStr -> Set<seq>
  for (const r of rows.rows) {
    const parsed = parseSeq(r.id, prefix)
    if (!parsed) continue
    if (!buckets.has(parsed.dateStr)) buckets.set(parsed.dateStr, new Set())
    buckets.get(parsed.dateStr).add(parsed.seq)
  }

  const result = {
    table, prefix,
    totalDays: buckets.size,
    totalRows: rows.rows.length,
    daysWithGap: 0,
    totalGapCount: 0,
    samplesWithGap: [],
  }

  const dates = [...buckets.keys()].sort()
  for (const dateStr of dates) {
    const seqs = [...buckets.get(dateStr)].sort((a, b) => a - b)
    if (seqs.length === 0) continue
    const minSeq = seqs[0]
    const maxSeq = seqs[seqs.length - 1]
    const expected = maxSeq - minSeq + 1
    const gaps = expected - seqs.length
    if (gaps > 0) {
      result.daysWithGap++
      result.totalGapCount += gaps
      // 找具体 gap 序号
      const gapSeqs = []
      const seqSet = new Set(seqs)
      for (let s = minSeq; s <= maxSeq; s++) {
        if (!seqSet.has(s)) gapSeqs.push(s)
      }
      result.samplesWithGap.push({
        date: dateStr,
        firstSeq: minSeq, lastSeq: maxSeq, actualCount: seqs.length, gapCount: gaps,
        gaps: gapSeqs.slice(0, 10), // 最多展示 10 个
      })
    }
  }
  return result
}

async function snapshotXactStats() {
  const r = await pool.query(
    `SELECT datname, xact_commit, xact_rollback, deadlocks
     FROM pg_stat_database WHERE datname = current_database()`
  )
  return r.rows[0]
}

async function main() {
  rec(`[monitor-pk-conflicts] ${new Date().toISOString()}`)
  rec(`  PG: ${PG_CONNECTION_STRING.replace(/:[^@]*@/, ':***@')}`)
  rec(`  窗口: 最近 ${DAYS} 天`)

  const sinceDate = new Date()
  sinceDate.setDate(sinceDate.getDate() - DAYS)
  const sinceIso = sinceDate.toISOString()
  rec(`  起点: ${sinceIso}`)
  rec('')

  // ─── 1. 序号 gap 分析 ───
  rec('━━━ ① sale_orders 序号 gap 分析 ━━━')
  const saleGap = await gapAnalysis('sale_orders', 'sale_order_id', 'FY-XSD-WX-', sinceIso)
  rec(`  总行数: ${saleGap.totalRows} | 覆盖天数: ${saleGap.totalDays}`)
  rec(`  有 gap 的天数: ${saleGap.daysWithGap} | 累计 gap 序号数: ${saleGap.totalGapCount}`)
  if (saleGap.samplesWithGap.length > 0) {
    rec(`  示例（前 5 天）:`)
    for (const s of saleGap.samplesWithGap.slice(0, 5)) {
      rec(`    ${s.date}: 实际 ${s.actualCount} 单 / 期望 ${s.lastSeq - s.firstSeq + 1} 单 / gap ${s.gapCount} 个 (${s.gaps.slice(0, 5).join(',')}${s.gaps.length > 5 ? '...' : ''})`)
    }
  }
  rec('')

  rec('━━━ ② service_orders 序号 gap 分析 ━━━')
  const svcGap = await gapAnalysis('service_orders', 'service_order_id', 'HLD-WX-', sinceIso)
  rec(`  总行数: ${svcGap.totalRows} | 覆盖天数: ${svcGap.totalDays}`)
  rec(`  有 gap 的天数: ${svcGap.daysWithGap} | 累计 gap 序号数: ${svcGap.totalGapCount}`)
  if (svcGap.samplesWithGap.length > 0) {
    rec(`  示例（前 5 天）:`)
    for (const s of svcGap.samplesWithGap.slice(0, 5)) {
      rec(`    ${s.date}: 实际 ${s.actualCount} 单 / 期望 ${s.lastSeq - s.firstSeq + 1} 单 / gap ${s.gapCount} 个 (${s.gaps.slice(0, 5).join(',')}${s.gaps.length > 5 ? '...' : ''})`)
    }
  }
  rec('')

  rec('  注：gap 不能 100% 等同于 PK 冲突 — 业务层 ROLLBACK（如优惠券失效、余额不足）也会留 gap。')
  rec('       但修复 advisory lock TOCTOU 后，并发撞号 ROLLBACK 这部分会归零，gap 总数应单调下降。')
  rec('       建议部署前后各跑一次本脚本，对比 totalGapCount 变化。')
  rec('')

  // ─── 3. xact_rollback 采样（可选） ───
  if (ROLLBACK_WAIT > 0) {
    rec(`━━━ ③ pg_stat_database 事务 rollback 增量（采样窗口 ${ROLLBACK_WAIT}s）━━━`)
    const before = await snapshotXactStats()
    rec(`  T0 commits=${before.xact_commit} rollbacks=${before.xact_rollback} deadlocks=${before.deadlocks}`)
    rec(`  等待 ${ROLLBACK_WAIT}s ...`)
    await new Promise(r => setTimeout(r, ROLLBACK_WAIT * 1000))
    const after = await snapshotXactStats()
    rec(`  T1 commits=${after.xact_commit} rollbacks=${after.xact_rollback} deadlocks=${after.deadlocks}`)
    const dc = after.xact_commit - before.xact_commit
    const dr = after.xact_rollback - before.xact_rollback
    const dd = after.deadlocks - before.deadlocks
    const total = dc + dr
    const rollbackRate = total > 0 ? (dr / total * 100).toFixed(3) : 'N/A'
    rec(`  Δ commit=${dc} rollback=${dr} deadlocks=${dd}`)
    rec(`  rollback 率: ${rollbackRate}% (含全部业务回滚，advisory lock 撞号回滚只是其中一类)`)
  } else {
    rec('━━━ ③ pg_stat_database 采样（未启用，设 ROLLBACK_WAIT=300 启用 5 分钟采样）━━━')
    const snap = await snapshotXactStats()
    rec(`  瞬时快照 commits=${snap.xact_commit} rollbacks=${snap.xact_rollback} deadlocks=${snap.deadlocks}`)
  }
  rec('')

  rec('━━━ 生产 PG 日志监控（需 SSH 到 PG host） ━━━')
  rec('  历史 7 天 sale_orders_pkey 冲突计数:')
  rec(`    grep -c 'duplicate key value violates unique constraint "sale_orders_pkey"' /var/log/postgresql/postgresql-*.log`)
  rec('  历史 7 天 service_orders_pkey 冲突计数:')
  rec(`    grep -c 'duplicate key value violates unique constraint "service_orders_pkey"' /var/log/postgresql/postgresql-*.log`)
  rec('  按天分桶（部署前后趋势对比）:')
  rec(`    grep 'duplicate key.*sale_orders_pkey' /var/log/postgresql/postgresql-*.log | awk '{print $1}' | sort | uniq -c`)
}

try {
  await main()
} catch (e) {
  console.error('[monitor-pk-conflicts] EXCEPTION:', e.message)
  if (e?.stack) console.error(e.stack)
  process.exitCode = 1
} finally {
  await pool.end()
}
