#!/usr/bin/env node

/**
 * backfill-378-service-items-shengmei.js — 服务明细生美快照对齐 SKU 当前配置（#378）
 *
 * 背景：
 *   service_items.is_shengmei 原先从 sale_items 开单快照拷贝。开单后运营修改 SKU 的生美配置
 *   （如 2026-08-03 把 7 个「年轻态…ZX」SKU 由 false 改 true），已售未耗的卡此后核销仍按旧值计，
 *   销售板 / 人效板「生美实耗」与主表 V/X/Y 列随之偏差。
 *
 *   口径拍板（2026-09-25，issue #378）：
 *     - 生美标记以 SKU 级 product_skus.is_shengmei 为准
 *     - 服务明细在服务单创建时取 SKU 当前值，SKU 为 NULL 时回退 sale_items（staff service.js /
 *       admin services.ts 已改）
 *     - 历史月份接受因回填变化 → 全时段回填
 *
 * 回填规则（目标值与写入链路同源：COALESCE(product_skus.is_shengmei, sale_items.is_shengmei)）：
 *   UPDATE service_items SET is_shengmei = COALESCE(ps.is_shengmei, si.is_shengmei)
 *   WHERE COALESCE(ps.is_shengmei, si.is_shengmei) IS NOT NULL
 *     AND service_items.is_shengmei IS DISTINCT FROM COALESCE(ps.is_shengmei, si.is_shengmei)
 *   - SKU 为 NULL / 无 SKU 时按 sale_items 收敛；两者都为 NULL 的行不动
 *   - sale_items.is_shengmei 不动（开单快照继续服务生美业绩口径）
 *   - 软删除 SKU（deleted_at 非空）不过滤，按其 is_shengmei 计，与写入链路一致
 *   - 幂等：第二次运行命中 0 行
 *
 * 用法：
 *   # 预览（默认，只读事务）
 *   DATABASE_URL=... node db/scripts/backfill-378-service-items-shengmei.js [--month=2026-08]
 *
 *   # 预览「假如先修 SKU 配置」的效果（仅 dry-run 可用，不写 SKU）
 *   ... --simulate-sku=sku-1783053892504=true --simulate-sku=sku-1785905806296=false
 *
 *   # 实际写入：必须同时给 --execute 与 --confirm-target=<host>:<port>/<database>
 *   #（与连接串经 pg-connection-string 解析后的最终目标逐字相等，首行「目标库」即此值）
 *   ... --execute --confirm-target=<host>:<port>/<database> [--rollback-out=/path/rollback.json]
 *
 *   # 回滚：按写入时导出的原值逐行恢复。只恢复「当前值仍等于回填写入值」的行（CAS）；
 *   # 存在值已漂移的行时默认整批拒绝，确认后加 --allow-drift 跳过漂移行
 *   ... --rollback=/path/rollback.json --confirm-target=<host>:<port>/<database> [--allow-drift]
 *
 * 回滚文件生命周期：COMMIT 前写 <out>.pending（status=pending）；COMMIT 成功后写 <out>
 *   （status=committed）并删除 .pending。两者都以 wx 创建，不覆盖已有文件。
 *   两份文件都记录写入事务号 xid（pg_current_xact_id()）。
 *   ⚠ 残留 .pending 表示「提交状态未知」（COMMIT 与改名之间进程可能被杀），**不要手工删除**：
 *   直接拿它跑 --rollback —— 先用 pg_xact_status(xid) 查该事务真实状态：committed 则按 CAS 回滚；
 *   aborted 则判为未提交、不做任何改动（此时 .pending 可删）；in progress / 查不到（事务号过旧或超前）
 *   一律拒绝自动处理。
 *
 * 目标库：一律经 _lib/assert-db-target 白名单（dev 101.34.242.103 / prod 118.178.196.26，
 *   5433/fengyu_wxapp，拒绝 query 覆盖）；写入另需 --confirm-target 逐字确认。
 *   仅本地临时容器验证时可设 BACKFILL_378_ALLOW_LOOPBACK=1 放行 127.0.0.1 / localhost。
 *
 * 上线顺序：先部署 staffApi（prod）与 admin 的新写入链路，再执行本脚本；部署前空窗期若有新写入，
 *   部署后再跑一次（幂等）即可收敛。
 *
 * 输出：命中行按「品项分类 / SKU / 旧值→新值」汇总；--month 指定月份的生美实耗前后对照
 *   （全集团 + 逐店；谓词与 admin 销售板 runShengmeiConsume / 人效板 qShengmeiConsumeByStore /
 *   staff mgmt-dashboard queryShengmeiConsume 一致：已完成、service_date 在月内、剔除寄存单退款专用单）。
 */

const fs = require('node:fs')
const path = require('node:path')
const { Pool } = require('pg')
const { parse: parseConnectionString } = require('pg-connection-string')
const { assertDbTargetOrExit } = require('./_lib/assert-db-target')

// 与 fengyu-admin/src/lib/service-remark.ts DEPOSIT_REFUND_REMARK 同值
const DEPOSIT_REFUND_REMARK = '寄存单退款专用 — 老系统寄存疗程卡退款核销，不计消耗业绩'

function log(msg) {
  console.log(`[BACKFILL-378] ${msg}`)
}

function parseArgs(argv) {
  const opts = {
    month: '2026-08', simulate: new Map(), execute: false, confirmTarget: null,
    rollbackOut: null, rollback: null, allowDrift: false,
  }
  for (const arg of argv) {
    if (arg === '--execute') opts.execute = true
    else if (arg === '--allow-drift') opts.allowDrift = true
    else if (arg.startsWith('--month=')) opts.month = arg.slice('--month='.length)
    else if (arg.startsWith('--confirm-target=')) opts.confirmTarget = arg.slice('--confirm-target='.length)
    else if (arg.startsWith('--rollback-out=')) opts.rollbackOut = arg.slice('--rollback-out='.length)
    else if (arg.startsWith('--rollback=')) opts.rollback = arg.slice('--rollback='.length)
    else if (arg.startsWith('--simulate-sku=')) {
      const m = arg.slice('--simulate-sku='.length).match(/^(.+)=(true|false|null)$/)
      if (!m) throw new Error(`--simulate-sku 格式应为 <sku_id>=<true|false|null>，实际 ${arg}`)
      opts.simulate.set(m[1], m[2] === 'null' ? null : m[2] === 'true')
    } else {
      throw new Error(`未知参数: ${arg}`)
    }
  }
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(opts.month)) throw new Error(`--month 应为 YYYY-MM（月份 01–12），实际 ${opts.month}`)
  if (opts.simulate.size > 0 && (opts.execute || opts.rollback)) {
    throw new Error('--simulate-sku 只能用于 dry-run：模拟值不会写入 SKU，拿它回填会写出与 SKU 不一致的快照')
  }
  if (opts.execute && opts.rollback) throw new Error('--execute 与 --rollback 不能同时使用')
  if (opts.allowDrift && !opts.rollback) throw new Error('--allow-drift 只用于 --rollback')
  return opts
}

function monthRange(month) {
  const [y, m] = month.split('-').map(Number)
  const lastDay = new Date(Date.UTC(y, m, 0)).getUTCDate()
  return { start: `${month}-01`, end: `${month}-${String(lastDay).padStart(2, '0')}` }
}

/**
 * 目标值表达式：COALESCE(SKU 当前值（叠加 --simulate-sku 覆盖）, sale_items 开单快照)，
 * 与 staff service.js / admin services.ts 的写入链路同源。
 * 覆盖以数组参数传入（$1 sku_id[] / $2 值[]），不拼接字面量；无覆盖时两数组为空。
 * 调用方须 LEFT JOIN product_skus ps（无 SKU 时 ps.* 为 NULL → 回退 si）。
 */
function targetExpr() {
  return `COALESCE(
            CASE WHEN ps.sku_id = ANY($1::text[])
                 THEN (($2::text[])[array_position($1::text[], ps.sku_id)])::boolean
                 ELSE ps.is_shengmei END,
            si.is_shengmei)`
}

function simulateParams(simulate) {
  const ids = [...simulate.keys()]
  const vals = ids.map((id) => (simulate.get(id) === null ? null : String(simulate.get(id))))
  return [ids, vals]
}

const CANDIDATES_SQL = `
SELECT sit.service_item_id, sit.is_shengmei AS old_value, ${targetExpr()} AS new_value,
       ps.sku_id, ps.spec_name, pc.category_name
FROM service_items sit
JOIN sale_items si ON si.sale_item_id = sit.sale_item_id
LEFT JOIN product_skus ps ON ps.sku_id = si.sku_id
LEFT JOIN product_categories pc ON pc.category_id = ps.category_id
WHERE ${targetExpr()} IS NOT NULL
  AND sit.is_shengmei IS DISTINCT FROM ${targetExpr()}
ORDER BY sit.service_item_id
`

/**
 * 生美实耗：按「当前快照」与「回填后」两列同时算，逐店。
 * 回填后值 = COALESCE(目标值, 当前快照)，与 CANDIDATES_SQL 的改写规则一一对应
 * （目标值为 NULL 即 SKU 与 sale_items 都为 NULL 的行不改）。
 */
const AFTER_EXPR = `COALESCE(${targetExpr()}, sit.is_shengmei)`
const MONTH_COMPARE_SQL = `
SELECT so.store_id, st.store_name,
       COALESCE(SUM(sit.unit_real_price::numeric * sit.session_used) FILTER (WHERE sit.is_shengmei = TRUE), 0) AS before_amt,
       COALESCE(SUM(sit.unit_real_price::numeric * sit.session_used) FILTER (WHERE ${AFTER_EXPR} = TRUE), 0) AS after_amt,
       COALESCE(SUM(sit.session_used) FILTER (WHERE sit.is_shengmei = TRUE), 0) AS before_cnt,
       COALESCE(SUM(sit.session_used) FILTER (WHERE ${AFTER_EXPR} = TRUE), 0) AS after_cnt
FROM service_orders so
JOIN service_items sit ON sit.service_order_id = so.service_order_id
JOIN sale_items si ON si.sale_item_id = sit.sale_item_id
LEFT JOIN product_skus ps ON ps.sku_id = si.sku_id
LEFT JOIN stores st ON st.store_id = so.store_id
WHERE so.status = '已完成'
  AND so.service_date BETWEEN $3 AND $4
  AND so.remark IS DISTINCT FROM $5
GROUP BY so.store_id, st.store_name
ORDER BY so.store_id
`

function fmt(n) {
  return Number(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
}

function signed(n) {
  return `${n >= 0 ? '+' : ''}${fmt(n)}`
}

function summarizeCandidates(rows) {
  const groups = new Map()
  for (const r of rows) {
    const key = `${r.category_name ?? '(无分类)'} | ${r.spec_name ?? '(无 SKU)'} | ${r.old_value}→${r.new_value}`
    groups.set(key, (groups.get(key) || 0) + 1)
  }
  return [...groups.entries()].sort((a, b) => b[1] - a[1])
}

async function printMonthCompare(client, opts, label) {
  const { start, end } = monthRange(opts.month)
  const [ids, vals] = simulateParams(opts.simulate)
  const { rows } = await client.query(MONTH_COMPARE_SQL, [ids, vals, start, end, DEPOSIT_REFUND_REMARK])
  let before = 0, after = 0, beforeCnt = 0, afterCnt = 0
  log(`--- ${opts.month} 生美实耗 ${label}（已完成、剔除寄存单退款专用单；逐店）---`)
  log('store_id | store_name | 当前快照 | 回填后 | 差额 | 生美项目数 当前→回填后')
  for (const r of rows) {
    before += Number(r.before_amt); after += Number(r.after_amt)
    beforeCnt += Number(r.before_cnt); afterCnt += Number(r.after_cnt)
    log(`${r.store_id} | ${r.store_name ?? ''} | ${fmt(r.before_amt)} | ${fmt(r.after_amt)} | ${signed(Number(r.after_amt) - Number(r.before_amt))} | ${r.before_cnt}→${r.after_cnt}`)
  }
  log(`全集团 | 当前快照 ${fmt(before)} | 回填后 ${fmt(after)} | 差额 ${signed(after - before)} | 生美项目数 ${beforeCnt}→${afterCnt}`)
}

function resolveTarget(connectionString) {
  // 用 pg 自己的解析器取最终目标（含 ?host= / ?port= 等 query 覆盖），避免只看 URL authority 被绕过
  const cfg = parseConnectionString(connectionString)
  return { host: cfg.host || null, port: String(cfg.port || 5432), database: cfg.database || null }
}

function targetLabel(t) {
  return `${t.host}:${t.port}/${t.database}`
}

function sameTarget(a, b) {
  return !!a && !!b && a.host === b.host && String(a.port) === String(b.port) && a.database === b.database
}

function writeJsonExclusive(file, data) {
  fs.writeFileSync(file, JSON.stringify(data, null, 2), { flag: 'wx' })
}

function preview(list) {
  return `${list.slice(0, 20).join(', ')}${list.length > 20 ? ' …' : ''}`
}

async function runRollback(pool, opts, target) {
  const file = JSON.parse(fs.readFileSync(opts.rollback, 'utf8'))
  if (file.issue !== 378 || !['committed', 'pending'].includes(file.status)) {
    throw new Error(`回滚文件无效：issue=${file.issue} status=${file.status}（只接受 #378 的 committed / pending 文件）`)
  }
  const pending = file.status === 'pending'
  if (!/^\d+$/.test(String(file.xid ?? ''))) {
    throw new Error(`回滚文件的写入事务号 xid 缺失或非法（${file.xid ?? '缺失'}；旧格式文件或被改动），请人工核对后处理`)
  }
  if (!sameTarget(file.target, target)) {
    throw new Error(`回滚文件目标 ${targetLabel(file.target)} 与当前连接 ${targetLabel(target)} 不一致，已拒绝`)
  }
  const entries = file.rows
  log(`回滚文件 ${opts.rollback}：${entries.length} 行（${pending ? '提交状态未知，按事务号判定' : `提交于 ${file.committedAt}`}）`)
  const ids = entries.map((e) => e.service_item_id)
  const oldVals = entries.map((e) => (e.old_value === null ? null : String(e.old_value)))
  const newVals = entries.map((e) => (e.new_value === null ? null : String(e.new_value)))

  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    await client.query(`SET LOCAL lock_timeout = '5s'`)
    if (pending) {
      // 值相等不能证明来自该事务（可能是后来另一次回填写的），只认事务号的真实状态
      const { rows: [x] } = await client.query('SELECT pg_xact_status($1::xid8) AS status', [file.xid])
      log(`pending 文件写入事务 xid=${file.xid} 状态: ${x.status ?? '(查不到)'}`)
      if (x.status === 'aborted') {
        await client.query('ROLLBACK')
        log('该次写入未提交，未做任何改动；该 .pending 文件可删除')
        return
      }
      if (x.status !== 'committed') {
        throw new Error(`无法确认 xid=${file.xid} 的提交状态（${x.status ?? '查不到'}），拒绝自动回滚，请人工核对`)
      }
    }
    // 先锁住文件内仍存在的行，再按 CAS 分类：命中 / 值已漂移 / 已不存在
    const { rows: present } = await client.query(
      `SELECT sit.service_item_id,
              sit.is_shengmei IS DISTINCT FROM v.new_value::boolean AS drifted
         FROM unnest($1::text[], $2::text[]) AS v(service_item_id, new_value)
         JOIN service_items sit ON sit.service_item_id = v.service_item_id
          FOR UPDATE OF sit`,
      [ids, newVals],
    )
    const presentIds = new Set(present.map((r) => r.service_item_id))
    const missing = ids.filter((id) => !presentIds.has(id))
    const drifted = present.filter((r) => r.drifted).map((r) => r.service_item_id)
    if (missing.length) log(`已不存在（跳过）${missing.length} 行：${preview(missing)}`)
    if (drifted.length) {
      log(`值已漂移 ${drifted.length} 行：${preview(drifted)}`)
      if (!opts.allowDrift) throw new Error('存在值已漂移的行，未回滚；确认跳过这些行后加 --allow-drift 重跑')
    }
    const res = await client.query(
      `UPDATE service_items sit
          SET is_shengmei = v.old_value::boolean, updated_at = NOW()
         FROM unnest($1::text[], $2::text[], $3::text[]) AS v(service_item_id, old_value, new_value)
        WHERE sit.service_item_id = v.service_item_id
          AND sit.is_shengmei IS NOT DISTINCT FROM v.new_value::boolean`,
      [ids, oldVals, newVals],
    )
    const expected = entries.length - missing.length - drifted.length
    if (res.rowCount !== expected) {
      throw new Error(`回滚命中 ${res.rowCount} 行 ≠ 预期 ${expected} 行，已回退事务`)
    }
    await client.query('COMMIT')
    log(`✓ 已回滚 ${res.rowCount} 行（跳过：不存在 ${missing.length} / 漂移 ${drifted.length}）`)
  } catch (err) {
    await client.query('ROLLBACK').catch((e) => log(`ROLLBACK 失败（原始错误见下）: ${e.message}`))
    throw err
  } finally {
    client.release()
  }
}

async function runBackfill(pool, opts, target) {
  const client = await pool.connect()
  let committed = false
  try {
    // dry-run 也在只读事务里跑，防误写
    await client.query(opts.execute ? 'BEGIN' : 'BEGIN READ ONLY')
    await client.query(`SET LOCAL lock_timeout = '5s'`)
    const [ids, vals] = simulateParams(opts.simulate)
    if (ids.length > 0) {
      const { rows: found } = await client.query(`SELECT sku_id FROM product_skus WHERE sku_id = ANY($1::text[])`, [ids])
      const foundIds = new Set(found.map((r) => r.sku_id))
      const unknown = ids.filter((id) => !foundIds.has(id))
      if (unknown.length) throw new Error(`--simulate-sku 指定的 SKU 不存在: ${unknown.join(', ')}`)
    }

    const { rows: candidates } = await client.query(CANDIDATES_SQL, [ids, vals])
    log(`--- 待回填 service_items：${candidates.length} 行（全时段）---`)
    for (const [key, n] of summarizeCandidates(candidates)) log(`  ${n.toString().padStart(6)}  ${key}`)

    await printMonthCompare(client, opts, '回填前后对照')

    if (!opts.execute) {
      await client.query('ROLLBACK')
      log('DRY-RUN 结束，未写入')
      return
    }
    if (candidates.length === 0) {
      await client.query('ROLLBACK')
      log('无待回填行，未写入')
      return
    }

    const rollbackOut = opts.rollbackOut || path.resolve(
      process.cwd(),
      `backfill-378-rollback-${String(target.host).replace(/[^\w.-]/g, '_')}-${new Date().toISOString().replace(/[:.]/g, '-')}.json`,
    )
    const pendingOut = `${rollbackOut}.pending`
    if (fs.existsSync(rollbackOut) || fs.existsSync(pendingOut)) {
      throw new Error(`回滚文件已存在，拒绝覆盖: ${rollbackOut}(.pending)`)
    }

    // 再次按同一目标表达式（此时无模拟覆盖）+ 仍不一致为条件，防止并发改动后覆盖；RETURNING 取实际写入值
    const res = await client.query(
      `UPDATE service_items sit
          SET is_shengmei = t.target, updated_at = NOW()
         FROM (
           SELECT sit2.service_item_id, ${targetExpr()} AS target
             FROM service_items sit2
             JOIN sale_items si ON si.sale_item_id = sit2.sale_item_id
             LEFT JOIN product_skus ps ON ps.sku_id = si.sku_id
            WHERE sit2.service_item_id = ANY($3::text[])
         ) t
        WHERE sit.service_item_id = t.service_item_id
          AND t.target IS NOT NULL
          AND sit.is_shengmei IS DISTINCT FROM t.target
      RETURNING sit.service_item_id, sit.is_shengmei AS new_value`,
      [[], [], candidates.map((r) => r.service_item_id)],
    )
    if (res.rowCount !== candidates.length) {
      throw new Error(`UPDATE 命中 ${res.rowCount} 行 ≠ 预览 ${candidates.length} 行（期间有并发改动？重跑即可），已回退事务`)
    }
    const written = new Map(res.rows.map((r) => [r.service_item_id, r.new_value]))
    const { rows: [{ xid }] } = await client.query('SELECT pg_current_xact_id()::text AS xid')
    const payload = {
      issue: 378,
      status: 'pending',
      xid,
      target,
      generatedAt: new Date().toISOString(),
      rows: candidates.map((r) => ({
        service_item_id: r.service_item_id,
        old_value: r.old_value,
        new_value: written.get(r.service_item_id),
      })),
    }
    writeJsonExclusive(pendingOut, payload)
    await client.query('COMMIT')
    committed = true
    try {
      writeJsonExclusive(rollbackOut, { ...payload, status: 'committed', committedAt: new Date().toISOString() })
    } catch (err) {
      // 数据已提交：.pending 是唯一原值记录，可直接用于 --rollback（按 xid 判定已提交）
      log(`⚠ 数据已提交，但写 committed 回滚文件失败: ${err.message}`)
      log(`⚠ 原值保存在 ${pendingOut}（xid=${xid}），需要回滚时直接 --rollback=${pendingOut}；切勿删除`)
      process.exitCode = 2
      return
    }
    try {
      fs.unlinkSync(pendingOut)
    } catch (err) {
      log(`⚠ committed 回滚文件已写出，但删除 ${pendingOut} 失败: ${err.message}（committed 文件已是权威回滚记录，此 .pending 可手工删除）`)
      process.exitCode = 2
    }
    log(`✓ 已回填 ${res.rowCount} 行；回滚文件: ${rollbackOut}`)

    // 写入后复算：此时快照 = SKU，「当前快照」列即回填后的真实值
    try {
      await printMonthCompare(client, { ...opts, simulate: new Map() }, '写入后复核')
    } catch (err) {
      log(`⚠ 数据已提交，但写入后复核查询失败: ${err.message}（可再跑一次 dry-run 复核）`)
      process.exitCode = 2
    }
  } catch (err) {
    if (!committed) {
      await client.query('ROLLBACK').catch((e) => log(`ROLLBACK 失败（原始错误见下）: ${e.message}`))
    }
    throw err
  } finally {
    client.release()
  }
}

async function main() {
  const opts = parseArgs(process.argv.slice(2))
  const connectionString = process.env.DATABASE_URL || process.env.PG_CONNECTION_STRING
  if (!connectionString) {
    console.error('请设置 DATABASE_URL 或 PG_CONNECTION_STRING')
    process.exit(1)
  }
  const target = resolveTarget(connectionString)
  const loopbackAllowed = process.env.BACKFILL_378_ALLOW_LOOPBACK === '1'
    && ['127.0.0.1', 'localhost'].includes(target.host)
  if (!loopbackAllowed) assertDbTargetOrExit(connectionString)
  log(`目标库: ${targetLabel(target)}${loopbackAllowed ? '（本地 loopback 验证模式）' : ''}`)
  log(`模式: ${opts.rollback ? `ROLLBACK（${opts.rollback}）` : opts.execute ? 'EXECUTE（实际写入）' : 'DRY-RUN（只读预览）'}`)
  if (opts.simulate.size > 0) {
    log(`模拟 SKU 配置: ${[...opts.simulate.entries()].map(([k, v]) => `${k}=${v}`).join(', ')}`)
  }
  if (opts.execute || opts.rollback) {
    if (!target.host || !target.database) {
      console.error('写入要求连接串显式给出 host 与 database（不依赖 PGHOST 等环境变量），已拒绝')
      process.exit(1)
    }
    if (opts.confirmTarget !== targetLabel(target)) {
      console.error(`写入需 --confirm-target=${targetLabel(target)}（实际传入 ${opts.confirmTarget ?? '(无)'}），已拒绝`)
      process.exit(1)
    }
  }

  const pool = new Pool({ connectionString, max: 2 })
  try {
    if (opts.rollback) await runRollback(pool, opts, target)
    else await runBackfill(pool, opts, target)
  } finally {
    await pool.end()
  }
}

main().catch((err) => {
  console.error('[BACKFILL-378] 失败:', err.message)
  process.exit(1)
})
