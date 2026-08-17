'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const crypto = require('node:crypto')
const fs = require('node:fs')
const path = require('node:path')

const dbDir = path.resolve(__dirname, '../..')

function read(relativePath) {
  return fs.readFileSync(path.join(dbDir, relativePath), 'utf8')
}

function sha256(relativePath) {
  return crypto.createHash('sha256').update(
    fs.readFileSync(path.join(dbDir, relativePath)),
  ).digest('hex')
}

function receiptTotals(sql) {
  const match = sql.match(/receipt_totals AS \(([\s\S]*?)\),\n  residuals AS/)
  assert.ok(match, '应存在 receipt_totals CTE')
  return match[1]
}

test('已发布 0009/0010/0011 SQL 与旧 snapshot 字节保持不变', () => {
  const publishedHashes = {
    'migrations/0009_massive_speed_demon.sql': 'd2da4e48bc26685522792c41aad346fc4b406df87b362065444ac1e43d378e34',
    'migrations/0010_flaky_thunderbolt_ross.sql': '85265958e73412ae4070682db2d557233534ddc7d150cecca6e94e2f63229e37',
    'migrations/0011_crazy_pestilence.sql': '4977e53532d53a2b41c0a1d0dbe6cb6768705c479bf69bc9f7b9224c4122bc1f',
    'migrations/meta/0009_snapshot.json': '1f7c3f86249fd6150fd98f898d02d4cd07905cbfcfac50925dec86821c8648ae',
    'migrations/meta/0010_snapshot.json': '8ea12b4a6f435192c197027df9ba40c698efa10e9f998953f59271f2c8c75a70',
    'migrations/meta/0011_snapshot.json': '8efaa05d0ec25a2066ec9d8ac5d10f3e92e2248ea355abcc1b853e4a5f27214e',
  }

  for (const [relativePath, expectedHash] of Object.entries(publishedHashes)) {
    assert.equal(sha256(relativePath), expectedHash, `${relativePath} 不得原地修改`)
  }
})

test('0012 通过新迁移把品项业绩残差改为全部 receipt 的有符号净额', () => {
  const oldMigrationTotals = receiptTotals(read('migrations/0010_flaky_thunderbolt_ross.sql'))
  const migrationTotals = receiptTotals(read('migrations/0012_neat_zeigeist.sql'))
  const schemaTotals = receiptTotals(read('schema/order.ts'))
  const snapshot = JSON.parse(read('migrations/meta/0012_snapshot.json'))
  const snapshotTotals = receiptTotals(snapshot.views['public.sale_item_performance_events'].definition)

  assert.match(oldMigrationTotals, /FILTER/)
  for (const definition of [migrationTotals, schemaTotals, snapshotTotals]) {
    assert.match(definition, /SUM\(amount\)::numeric\(10, 2\)/)
    assert.doesNotMatch(definition, /FILTER|change_type/)
  }
})

test('0012 从卡流水净额补齐支付流水缺口，并从权威流水幂等重算快照', () => {
  const sql = read('migrations/0012_neat_zeigeist.sql')
  const evidenceAt = sql.indexOf('WITH card_evidence AS')
  const insertAt = sql.indexOf('INSERT INTO sale_order_payments', evidenceAt)
  const recalcAt = sql.indexOf('WITH card_totals AS', insertAt)
  const itemRecalcAt = sql.indexOf('WITH ranked AS', recalcAt)

  assert.ok(evidenceAt > 0, '应从 card_transactions 重建扣卡事实')
  assert.ok(insertAt > evidenceAt, '应补齐缺失的储值卡支付流水')
  assert.ok(recalcAt > insertAt, '应在补流水后重算订单快照')
  assert.ok(itemRecalcAt > recalcAt, '应在订单快照后重算行级卡款快照')
  assert.match(sql, /GREATEST\(0, ROUND\(-SUM\(ct\.amount::numeric\), 2\)\)/)
  assert.match(sql, /evidenced_prepaid - scp\.settled_prepaid/)
  assert.match(sql, /WHERE ROUND\(ce\.evidenced_prepaid - scp\.settled_prepaid, 2\) > 0/)
  assert.match(sql, /migration:0012:card-transaction-recovery/)
  assert.match(sql, /so\.total_amount::numeric - ct\.settled_prepaid - so\.pending_prepaid_card_amount::numeric/)
  assert.doesNotMatch(sql, /payable_amount\s*[+-]/)
  assert.match(sql, /prepaid_card_received IS DISTINCT FROM targets\.prepaid_share/)
})

test('0012 按 WorkFine 原始快照日期修复已执行 0009 的归属日', () => {
  const sql = read('migrations/0012_neat_zeigeist.sql')
  const workfineRepair = sql.match(/WITH workfine_dates AS \(([\s\S]*?)--> statement-breakpoint/)

  assert.ok(workfineRepair, '应存在 WorkFine 归属日补迁移')
  assert.match(workfineRepair[1], /legacy_raw_snapshot ->> 'sale_date'/)
  assert.match(workfineRepair[1], /AT TIME ZONE 'UTC'/)
  assert.match(workfineRepair[1], /legacy_source = 'workfine'/)
  assert.match(workfineRepair[1], /IS DISTINCT FROM wd\.business_date/)
})

test('0012 journal 与 snapshot 由 drizzle generate 连续生成', () => {
  const journal = JSON.parse(read('migrations/meta/_journal.json'))
  const snapshot11 = JSON.parse(read('migrations/meta/0011_snapshot.json'))
  const snapshot12 = JSON.parse(read('migrations/meta/0012_snapshot.json'))
  const last = journal.entries.at(-1)

  assert.equal(last.idx, 12)
  assert.equal(last.tag, '0012_neat_zeigeist')
  assert.ok(last.when > journal.entries.at(-2).when)
  assert.equal(snapshot12.prevId, snapshot11.id)
})
