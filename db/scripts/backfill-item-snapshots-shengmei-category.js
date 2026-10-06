#!/usr/bin/env node

/**
 * backfill-item-snapshots-shengmei-category.js
 *   用**当前** SKU / 品项分类配置刷新订单商品明细与服务单明细的四列快照：
 *
 *     sale_items.is_shengmei        ← product_skus.is_shengmei
 *     sale_items.sales_category     ← product_categories.sales_category（按 SKU 所属分类）
 *     service_items.is_shengmei     ← COALESCE(product_skus.is_shengmei, sale_items.is_shengmei)
 *     service_items.sales_category  ← COALESCE(product_categories.sales_category, sale_items.sales_category)
 *
 * 背景：
 *   这四列都是**开单 / 建单时点**的快照。运营事后修改 SKU 的生美标记
 *   （product_skus.is_shengmei）或二级品项分类的经营类型（product_categories.sales_category）后，
 *   历史行仍留旧值，看板「生美业绩 / 实耗」「按经营类型汇总」便与当前商品配置对不上。
 *   本脚本按当前配置把四列重新对齐（幂等）。
 *
 * ⚠ 口径（2026-10-06 用户要求，与 #378 的关系须留意）：
 *   - service_items.is_shengmei 的目标值与 staff/admin 写入链路同源（#378）：
 *     COALESCE(product_skus.is_shengmei, sale_items.is_shengmei)。
 *   - sale_items.is_shengmei 在 #378 里定为「**不回填**的开单快照（生美业绩口径）」；
 *     本脚本按用户要求把它一并对齐到当前 SKU 值 —— 这会让历史「生美业绩」随 SKU 配置变化。
 *     运行前确认这是有意的；若要保留开单快照口径，删除本脚本 STEP A 对 is_shengmei 的写入。
 *   - **NULL 源不覆盖**：SKU 未配 is_shengmei / 分类未配 sales_category 时保留原值（CASE 守卫）。
 *
 * 幂等：条件全部用 `IS DISTINCT FROM`，第二次运行命中 0 行、不写回滚文件。
 *
 * 用法：
 *   # 预览（默认，只读事务，绝不写库）
 *   DATABASE_URL=... node db/scripts/backfill-item-snapshots-shengmei-category.js
 *
 *   # 实际写入：须同时给 --execute 与 --confirm-target=<host>:<port>/<database>
 *   #（与连接串经 pg-connection-string 解析后的最终目标逐字相等，首行「目标库」即此值）
 *   DATABASE_URL=... node db/scripts/backfill-item-snapshots-shengmei-category.js \
 *     --execute --confirm-target=118.178.196.26:5433/fengyu_wxapp [--rollback-out=/path/rollback.json]
 *
 *   # 回滚：按写入时导出的原值逐行恢复。只恢复「当前值仍等于回填写入值」的行（CAS）；
 *   # 存在值已漂移的行时默认整批拒绝，确认后加 --allow-drift 跳过漂移行。
 *   DATABASE_URL=... node db/scripts/backfill-item-snapshots-shengmei-category.js \
 *     --rollback=/path/rollback.json --confirm-target=<host>:<port>/<database> [--allow-drift]
 *
 * 目标库：一律经 _lib/assert-db-target 白名单（dev 101.34.242.103 / prod 118.178.196.26，
 *   5433/fengyu_wxapp，拒绝 query 覆盖）；写入另需 --confirm-target 逐字确认。
 *   仅本地临时容器验证时可设 BACKFILL_SNAPSHOT_ALLOW_LOOPBACK=1 放行 127.0.0.1 / localhost。
 *
 * 输出：四类待改行数 + 「SKU / 分类 old→new」汇总；写入后复核一次。
 */

'use strict'

const fs = require('node:fs')
const path = require('node:path')
const { Pool } = require('pg')
const { parse: parseConnectionString } = require('pg-connection-string')
const { assertDbTargetOrExit } = require('./_lib/assert-db-target')

function log(msg) {
  console.log(`[BACKFILL-SNAPSHOT] ${msg}`)
}

function parseArgs(argv) {
  const opts = { execute: false, confirmTarget: null, rollbackOut: null, rollback: null, allowDrift: false }
  for (const arg of argv) {
    if (arg === '--execute') opts.execute = true
    else if (arg === '--allow-drift') opts.allowDrift = true
    else if (arg.startsWith('--confirm-target=')) opts.confirmTarget = arg.slice('--confirm-target='.length)
    else if (arg.startsWith('--rollback-out=')) opts.rollbackOut = arg.slice('--rollback-out='.length)
    else if (arg.startsWith('--rollback=')) opts.rollback = arg.slice('--rollback='.length)
    else throw new Error(`未知参数: ${arg}`)
  }
  if (opts.execute && opts.rollback) throw new Error('--execute 与 --rollback 不能同时使用')
  if (opts.allowDrift && !opts.rollback) throw new Error('--allow-drift 只用于 --rollback')
  return opts
}

/* ---------------------------------------------------------------------------
 * 候选行：目标值与写入链路同源，预览与执行共用同一段 SQL，避免两处口径漂移。
 * 每行给出 id 与四列的 old / new（new 为 NULL 表示源未配置，该列不动）。
 * ------------------------------------------------------------------------- */

const SALE_ITEMS_CANDIDATES_SQL = `
SELECT si.sale_item_id AS id,
       si.is_shengmei AS old_sm,
       CASE WHEN ps.is_shengmei IS NOT NULL THEN ps.is_shengmei ELSE si.is_shengmei END AS new_sm,
       si.sales_category AS old_sc,
       CASE WHEN pc.sales_category IS NOT NULL THEN pc.sales_category ELSE si.sales_category END AS new_sc,
       ps.sku_id, ps.spec_name, pc.category_name
  FROM sale_items si
  JOIN product_skus ps ON ps.sku_id = si.sku_id
  LEFT JOIN product_categories pc ON pc.category_id = ps.category_id
 WHERE (ps.is_shengmei IS NOT NULL AND si.is_shengmei IS DISTINCT FROM ps.is_shengmei)
    OR (pc.sales_category IS NOT NULL AND si.sales_category IS DISTINCT FROM pc.sales_category)
 ORDER BY si.sale_item_id
`

const SERVICE_ITEMS_CANDIDATES_SQL = `
SELECT sit.service_item_id AS id,
       sit.is_shengmei AS old_sm,
       CASE WHEN COALESCE(ps.is_shengmei, si.is_shengmei) IS NOT NULL
            THEN COALESCE(ps.is_shengmei, si.is_shengmei) ELSE sit.is_shengmei END AS new_sm,
       sit.sales_category AS old_sc,
       CASE WHEN COALESCE(pc.sales_category, si.sales_category) IS NOT NULL
            THEN COALESCE(pc.sales_category, si.sales_category) ELSE sit.sales_category END AS new_sc,
       ps.sku_id, ps.spec_name, pc.category_name
  FROM service_items sit
  JOIN sale_items si ON si.sale_item_id = sit.sale_item_id
  LEFT JOIN product_skus ps ON ps.sku_id = si.sku_id
  LEFT JOIN product_categories pc ON pc.category_id = ps.category_id
 WHERE (COALESCE(ps.is_shengmei, si.is_shengmei) IS NOT NULL
        AND sit.is_shengmei IS DISTINCT FROM COALESCE(ps.is_shengmei, si.is_shengmei))
    OR (COALESCE(pc.sales_category, si.sales_category) IS NOT NULL
        AND sit.sales_category IS DISTINCT FROM COALESCE(pc.sales_category, si.sales_category))
 ORDER BY sit.service_item_id
`

/**
 * 写入只针对预览命中的 id；target 在 SQL 内按同一表达式重算并再断一次 `IS DISTINCT FROM`，
 * 并发改动会让 rowCount 与预览不等 → 整事务回退。RETURNING 取实际写入值供回滚文件使用。
 * ⚠ 先更 sale_items 再更 service_items：service_items 的兜底列取自 sale_items，顺序固定。
 */
const SALE_ITEMS_UPDATE_SQL = `
UPDATE sale_items si
   SET is_shengmei = CASE WHEN ps.is_shengmei IS NOT NULL THEN ps.is_shengmei ELSE si.is_shengmei END,
       sales_category = CASE WHEN pc.sales_category IS NOT NULL THEN pc.sales_category ELSE si.sales_category END,
       updated_at = NOW()
  FROM product_skus ps
  LEFT JOIN product_categories pc ON pc.category_id = ps.category_id
 WHERE si.sku_id = ps.sku_id
   AND si.sale_item_id = ANY($1::text[])
   AND ((ps.is_shengmei IS NOT NULL AND si.is_shengmei IS DISTINCT FROM ps.is_shengmei)
     OR (pc.sales_category IS NOT NULL AND si.sales_category IS DISTINCT FROM pc.sales_category))
RETURNING si.sale_item_id AS id, si.is_shengmei AS new_sm, si.sales_category AS new_sc
`

const SERVICE_ITEMS_UPDATE_SQL = `
UPDATE service_items sit
   SET is_shengmei = CASE WHEN COALESCE(ps.is_shengmei, si.is_shengmei) IS NOT NULL
                          THEN COALESCE(ps.is_shengmei, si.is_shengmei) ELSE sit.is_shengmei END,
       sales_category = CASE WHEN COALESCE(pc.sales_category, si.sales_category) IS NOT NULL
                             THEN COALESCE(pc.sales_category, si.sales_category) ELSE sit.sales_category END,
       updated_at = NOW()
  FROM sale_items si
  LEFT JOIN product_skus ps ON ps.sku_id = si.sku_id
  LEFT JOIN product_categories pc ON pc.category_id = ps.category_id
 WHERE sit.sale_item_id = si.sale_item_id
   AND sit.service_item_id = ANY($1::text[])
   AND ((COALESCE(ps.is_shengmei, si.is_shengmei) IS NOT NULL
         AND sit.is_shengmei IS DISTINCT FROM COALESCE(ps.is_shengmei, si.is_shengmei))
     OR (COALESCE(pc.sales_category, si.sales_category) IS NOT NULL
         AND sit.sales_category IS DISTINCT FROM COALESCE(pc.sales_category, si.sales_category)))
RETURNING sit.service_item_id AS id, sit.is_shengmei AS new_sm, sit.sales_category AS new_sc
`

function summarize(rows, table) {
  const groups = new Map()
  for (const r of rows) {
    const key = `${table} | ${r.category_name ?? '(无分类)'} | ${r.spec_name ?? '(无 SKU)'} | 生美 ${r.old_sm}→${r.new_sm} | 类型 ${r.old_sc}→${r.new_sc}`
    groups.set(key, (groups.get(key) || 0) + 1)
  }
  return [...groups.entries()].sort((a, b) => b[1] - a[1])
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

/** 回滚文件里四列原值/写入值都以文本存，布尔与 enum 都走 ::text → ::原类型 还原 */
function toText(v) {
  return v === null || v === undefined ? null : String(v)
}

async function collectCandidates(client) {
  const { rows: saleRows } = await client.query(SALE_ITEMS_CANDIDATES_SQL)
  const { rows: svcRows } = await client.query(SERVICE_ITEMS_CANDIDATES_SQL)
  return { saleRows, svcRows }
}

async function printPreview(candidates) {
  const { saleRows, svcRows } = candidates
  log(`--- 待回填 sale_items：${saleRows.length} 行 ---`)
  for (const [key, n] of summarize(saleRows, 'sale_items')) log(`  ${String(n).padStart(6)}  ${key}`)
  log(`--- 待回填 service_items：${svcRows.length} 行 ---`)
  for (const [key, n] of summarize(svcRows, 'service_items')) log(`  ${String(n).padStart(6)}  ${key}`)
  return saleRows.length + svcRows.length
}

const SALE_ITEMS_ROLLBACK_SQL = `
UPDATE sale_items si
   SET is_shengmei = v.old_sm::boolean, sales_category = v.old_sc::sales_category, updated_at = NOW()
  FROM unnest($1::text[], $2::text[], $3::text[], $4::text[], $5::text[])
         AS v(id, old_sm, old_sc, new_sm, new_sc)
 WHERE si.sale_item_id = v.id
   AND (si.is_shengmei, si.sales_category) IS NOT DISTINCT FROM (v.new_sm::boolean, v.new_sc::sales_category)
`

const SERVICE_ITEMS_ROLLBACK_SQL = `
UPDATE service_items sit
   SET is_shengmei = v.old_sm::boolean, sales_category = v.old_sc::sales_category, updated_at = NOW()
  FROM unnest($1::text[], $2::text[], $3::text[], $4::text[], $5::text[])
         AS v(id, old_sm, old_sc, new_sm, new_sc)
 WHERE sit.service_item_id = v.id
   AND (sit.is_shengmei, sit.sales_category) IS NOT DISTINCT FROM (v.new_sm::boolean, v.new_sc::sales_category)
`

async function runRollback(pool, opts, target) {
  const file = JSON.parse(fs.readFileSync(opts.rollback, 'utf8'))
  if (file.script !== 'backfill-item-snapshots-shengmei-category' || !['committed', 'pending'].includes(file.status)) {
    throw new Error(`回滚文件无效：script=${file.script} status=${file.status}`)
  }
  if (!/^\d+$/.test(String(file.xid ?? ''))) {
    throw new Error(`回滚文件的写入事务号 xid 缺失或非法（${file.xid ?? '缺失'}），请人工核对后处理`)
  }
  if (!sameTarget(file.target, target)) {
    throw new Error(`回滚文件目标 ${targetLabel(file.target)} 与当前连接 ${targetLabel(target)} 不一致，已拒绝`)
  }
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    await client.query(`SET LOCAL lock_timeout = '5s'`)
    if (file.status === 'pending') {
      const { rows: [x] } = await client.query('SELECT pg_xact_status($1::xid8) AS status', [file.xid])
      log(`pending 文件写入事务 xid=${file.xid} 状态: ${x.status ?? '(查不到)'}`)
      if (x.status === 'aborted') {
        await client.query('ROLLBACK')
        log('该次写入未提交，未做任何改动；该 .pending 文件可删除')
        return
      }
      if (x.status !== 'committed') {
        throw new Error(`无法确认 xid=${file.xid} 的提交状态（${x.status ?? '查不到'}），拒绝自动回滚`)
      }
    }
    let restored = 0
    let skippedDrift = 0
    for (const [table, sql] of [['sale_items', SALE_ITEMS_ROLLBACK_SQL], ['service_items', SERVICE_ITEMS_ROLLBACK_SQL]]) {
      const entries = file[table === 'sale_items' ? 'saleItems' : 'serviceItems'] || []
      if (entries.length === 0) continue
      // 先看有多少行会因值漂移被 CAS 挡下
      const { rows: present } = await client.query(
        `SELECT t.id, (t.cur_sm, t.cur_sc) IS DISTINCT FROM (t.new_sm::boolean, t.new_sc::sales_category) AS drifted
           FROM (
             SELECT u.id,
                    x.is_shengmei AS cur_sm, x.sales_category AS cur_sc,
                    u.new_sm, u.new_sc
               FROM unnest($1::text[], $2::text[], $3::text[]) AS u(id, new_sm, new_sc)
               JOIN ${table} x ON x.${table === 'sale_items' ? 'sale_item_id' : 'service_item_id'} = u.id
           ) t`,
        [entries.map((e) => e.id), entries.map((e) => toText(e.new_sm)), entries.map((e) => toText(e.new_sc))],
      )
      const driftIds = new Set(present.filter((r) => r.drifted).map((r) => r.id))
      if (driftIds.size > 0) {
        log(`${table} 值已漂移 ${driftIds.size} 行（跳过）：${[...driftIds].slice(0, 20).join(', ')}${driftIds.size > 20 ? ' …' : ''}`)
        if (!opts.allowDrift) throw new Error('存在值已漂移的行，未回滚；确认跳过这些行后加 --allow-drift 重跑')
      }
      const usable = entries.filter((e) => !driftIds.has(e.id))
      if (usable.length === 0) continue
      const res = await client.query(sql, [
        usable.map((e) => e.id),
        usable.map((e) => toText(e.old_sm)),
        usable.map((e) => toText(e.old_sc)),
        usable.map((e) => toText(e.new_sm)),
        usable.map((e) => toText(e.new_sc)),
      ])
      if (res.rowCount !== usable.length) {
        throw new Error(`${table} 回滚命中 ${res.rowCount} 行 ≠ 预期 ${usable.length} 行，已回退事务`)
      }
      restored += res.rowCount
      skippedDrift += driftIds.size
    }
    await client.query('COMMIT')
    log(`✓ 已回滚 ${restored} 行（跳过漂移 ${skippedDrift}）`)
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

    const candidates = await collectCandidates(client)
    const total = await printPreview(candidates)

    if (!opts.execute) {
      await client.query('ROLLBACK')
      log(`DRY-RUN 结束，未写入（命中 ${total} 行）`)
      return
    }
    if (total === 0) {
      await client.query('ROLLBACK')
      log('无待回填行，未写入')
      return
    }

    const rollbackOut = opts.rollbackOut || path.resolve(
      process.cwd(),
      `backfill-snapshot-rollback-${String(target.host).replace(/[^\w.-]/g, '_')}-${new Date().toISOString().replace(/[:.]/g, '-')}.json`,
    )
    const pendingOut = `${rollbackOut}.pending`
    if (fs.existsSync(rollbackOut) || fs.existsSync(pendingOut)) {
      throw new Error(`回滚文件已存在，拒绝覆盖: ${rollbackOut}(.pending)`)
    }

    const writtenSale = await client.query(SALE_ITEMS_UPDATE_SQL, [candidates.saleRows.map((r) => r.id)])
    if (writtenSale.rowCount !== candidates.saleRows.length) {
      throw new Error(`sale_items UPDATE 命中 ${writtenSale.rowCount} 行 ≠ 预览 ${candidates.saleRows.length} 行（并发改动？），已回退事务`)
    }
    const writtenSvc = await client.query(SERVICE_ITEMS_UPDATE_SQL, [candidates.svcRows.map((r) => r.id)])
    if (writtenSvc.rowCount !== candidates.svcRows.length) {
      throw new Error(`service_items UPDATE 命中 ${writtenSvc.rowCount} 行 ≠ 预览 ${candidates.svcRows.length} 行（并发改动？），已回退事务`)
    }
    const svcNewById = new Map(writtenSvc.rows.map((r) => [r.id, r]))
    const saleNewById = new Map(writtenSale.rows.map((r) => [r.id, r]))

    const { rows: [{ xid }] } = await client.query('SELECT pg_current_xact_id()::text AS xid')
    const payload = {
      script: 'backfill-item-snapshots-shengmei-category',
      status: 'pending',
      xid,
      target,
      generatedAt: new Date().toISOString(),
      saleItems: candidates.saleRows.map((r) => ({
        id: r.id,
        old_sm: toText(r.old_sm), old_sc: toText(r.old_sc),
        new_sm: toText(saleNewById.get(r.id)?.new_sm), new_sc: toText(saleNewById.get(r.id)?.new_sc),
      })),
      serviceItems: candidates.svcRows.map((r) => ({
        id: r.id,
        old_sm: toText(r.old_sm), old_sc: toText(r.old_sc),
        new_sm: toText(svcNewById.get(r.id)?.new_sm), new_sc: toText(svcNewById.get(r.id)?.new_sc),
      })),
    }
    writeJsonExclusive(pendingOut, payload)
    await client.query('COMMIT')
    committed = true
    try {
      writeJsonExclusive(rollbackOut, { ...payload, status: 'committed', committedAt: new Date().toISOString() })
    } catch (err) {
      log(`⚠ 数据已提交，但写 committed 回滚文件失败: ${err.message}`)
      log(`⚠ 原值保存在 ${pendingOut}（xid=${xid}），需要回滚时直接 --rollback=${pendingOut}；切勿删除`)
      process.exitCode = 2
      return
    }
    try {
      fs.unlinkSync(pendingOut)
    } catch (err) {
      log(`⚠ committed 回滚文件已写出，但删除 ${pendingOut} 失败: ${err.message}`)
      process.exitCode = 2
    }
    log(`✓ 已回填 sale_items ${writtenSale.rowCount} 行 + service_items ${writtenSvc.rowCount} 行；回滚文件: ${rollbackOut}`)

    try {
      log('--- 写入后复核（应全部归零）---')
      await printPreview(await collectCandidates(client))
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
  const loopbackAllowed = process.env.BACKFILL_SNAPSHOT_ALLOW_LOOPBACK === '1'
    && ['127.0.0.1', 'localhost'].includes(target.host)
  if (!loopbackAllowed) assertDbTargetOrExit(connectionString)
  log(`目标库: ${targetLabel(target)}${loopbackAllowed ? '（本地 loopback 验证模式）' : ''}`)
  log(`模式: ${opts.rollback ? `ROLLBACK（${opts.rollback}）` : opts.execute ? 'EXECUTE（实际写入）' : 'DRY-RUN（只读预览）'}`)
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
  console.error('[BACKFILL-SNAPSHOT] 失败:', err.message)
  process.exit(1)
})
