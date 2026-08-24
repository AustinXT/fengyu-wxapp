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

const bad0011Marker = '系统迁移补齐历史储值卡实付'
const repair0013Marker = 'migration:0013:card-transaction-recovery-v2'

function isBad0011Payment(payment) {
  return payment.status === '已支付'
    && payment.changeType === '储值卡抵扣'
    && payment.paymentMethod === '储值卡'
    && payment.sourceEnd === 'admin'
    && payment.operatorEmployeeId == null
    && payment.externalTxnId == null
    && payment.refSaleItemId == null
    && payment.allocationStatus == null
    && payment.note === bad0011Marker
}

function reconcileCardHistory({ cardTransactions, payments }) {
  const repairedPayments = payments.map((payment) => ({ ...payment }))
  let invalidated = 0

  for (const payment of repairedPayments) {
    if (isBad0011Payment(payment)) {
      payment.status = '已作废'
      invalidated += 1
    }
  }

  const evidencedPrepaid = Math.max(
    0,
    -cardTransactions.reduce((sum, amount) => sum + amount, 0),
  )
  const settledPrepaid = repairedPayments.reduce((sum, payment) => {
    if (payment.status !== '已支付') return sum
    if (payment.changeType === '储值卡抵扣') return sum + payment.amount
    if (payment.changeType === '退款' && payment.paymentMethod === '储值卡') {
      return sum + payment.amount
    }
    return sum
  }, 0)
  const hasRepair = repairedPayments.some((payment) => (
    payment.status === '已支付' && payment.note === repair0013Marker
  ))
  const missingPrepaid = evidencedPrepaid - settledPrepaid
  let inserted = 0

  if (missingPrepaid > 0 && !hasRepair) {
    repairedPayments.push({
      status: '已支付',
      changeType: '储值卡抵扣',
      paymentMethod: '储值卡',
      amount: missingPrepaid,
      note: repair0013Marker,
    })
    inserted = missingPrepaid
  }

  return {
    payments: repairedPayments,
    invalidated,
    inserted,
    settledPrepaid: settledPrepaid + inserted,
  }
}

function bad0011Payment(amount) {
  return {
    status: '已支付',
    changeType: '储值卡抵扣',
    paymentMethod: '储值卡',
    sourceEnd: 'admin',
    operatorEmployeeId: null,
    externalTxnId: null,
    refSaleItemId: null,
    allocationStatus: null,
    note: bad0011Marker,
    amount,
  }
}

function roundDivHalfAway(numerator, denominator) {
  assert.notEqual(denominator, 0)
  const sign = Math.sign(numerator) * Math.sign(denominator)
  const absoluteNumerator = Math.abs(numerator)
  const absoluteDenominator = Math.abs(denominator)
  const rounded = Math.floor(
    (2 * absoluteNumerator + absoluteDenominator) / (2 * absoluteDenominator),
  )
  return sign * rounded
}

function allocateByCumulativeBoundary(totalCents, weights) {
  const totalWeight = weights.reduce((sum, weight) => sum + weight, 0)
  if (totalWeight === 0 || totalCents === 0) return weights.map(() => 0)

  let cumulativeWeight = 0
  let previousBoundary = 0
  return weights.map((weight) => {
    cumulativeWeight += weight
    const boundary = roundDivHalfAway(totalCents * cumulativeWeight, totalWeight)
    const share = boundary - previousBoundary
    previousBoundary = boundary
    return share
  })
}

test('已发布 0009–0012 SQL 与旧 snapshot 字节保持不变', () => {
  const publishedHashes = {
    'migrations/0009_massive_speed_demon.sql': 'd2da4e48bc26685522792c41aad346fc4b406df87b362065444ac1e43d378e34',
    'migrations/0010_flaky_thunderbolt_ross.sql': '85265958e73412ae4070682db2d557233534ddc7d150cecca6e94e2f63229e37',
    'migrations/0011_crazy_pestilence.sql': '4977e53532d53a2b41c0a1d0dbe6cb6768705c479bf69bc9f7b9224c4122bc1f',
    'migrations/0012_neat_zeigeist.sql': 'dd32caf50e9e1945f76b95e68c9025bd2a8d049ce1944bb5e396fffa5b70a66b',
    'migrations/meta/0009_snapshot.json': '1f7c3f86249fd6150fd98f898d02d4cd07905cbfcfac50925dec86821c8648ae',
    'migrations/meta/0010_snapshot.json': '8ea12b4a6f435192c197027df9ba40c698efa10e9f998953f59271f2c8c75a70',
    'migrations/meta/0011_snapshot.json': '8efaa05d0ec25a2066ec9d8ac5d10f3e92e2248ea355abcc1b853e4a5f27214e',
    'migrations/meta/0012_snapshot.json': 'f6d32457bb582cd543aa3fa19429977832c7c611160db60d4887a986bfa1c808',
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

test('0013 作废坏版 0011 合成行，再按有符号卡流水幂等补缺', () => {
  const sql = read('migrations/0013_repair_prepaid_card_history.sql')
  const invalidateAt = sql.indexOf('UPDATE sale_order_payments')
  const evidenceAt = sql.indexOf('WITH card_evidence AS')
  const insertAt = sql.indexOf('INSERT INTO sale_order_payments', evidenceAt)
  const orderRecalcAt = sql.indexOf('WITH repair_orders AS', insertAt)
  const itemRecalcAt = sql.indexOf('WITH ranked AS', orderRecalcAt)

  assert.ok(invalidateAt >= 0, '应保留并作废坏版 0011 合成行')
  assert.ok(evidenceAt > invalidateAt, '应在作废污染行后重算卡流水事实')
  assert.ok(insertAt > evidenceAt, '应补齐真实缺失的扣卡流水')
  assert.ok(orderRecalcAt > insertAt, '应在补流水后重建订单快照')
  assert.ok(itemRecalcAt > orderRecalcAt, '应在订单快照后重建行级分摊')
  assert.match(sql, /SET status = '已作废'::payment_flow_status/)
  assert.match(sql, /note = '系统迁移补齐历史储值卡实付'/)
  assert.match(sql, /change_type = '储值卡抵扣'/)
  assert.match(sql, /payment_method = '储值卡'/)
  assert.match(sql, /source_end = 'admin'/)
  assert.match(sql, /operator_employee_id IS NULL/)
  assert.match(sql, /external_txn_id IS NULL/)
  assert.match(sql, /ref_sale_item_id IS NULL/)
  assert.match(sql, /allocation_status IS NULL/)
  assert.doesNotMatch(sql, /DELETE\s+FROM\s+sale_order_payments/i)
  assert.match(sql, /GREATEST\(0, ROUND\(-SUM\(ct\.amount::numeric\), 2\)\)/)
  assert.match(sql, /sop\.change_type = '退款' AND sop\.payment_method = '储值卡'/)
  assert.match(sql, /evidenced_prepaid - sav\.settled_prepaid/)
  assert.match(sql, /WHERE ROUND\(ce\.evidenced_prepaid - sav\.settled_prepaid, 2\) > 0/)
  assert.match(sql, /migration:0013:card-transaction-recovery-v2/)
  assert.match(sql, /WHERE NOT EXISTS/)
  assert.match(sql, /so\.total_amount::numeric - ct\.settled_prepaid - so\.pending_prepaid_card_amount::numeric/)
  assert.match(sql, /ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW/)
  assert.match(sql, /ROUND\(prepaid_total \* cumulative_received \/ received_total, 2\)/)
  assert.match(sql, /ROUND\(prepaid_total \* \(cumulative_received - item_received\) \/ received_total, 2\)/)
  assert.doesNotMatch(sql, /WHEN rn = item_count/)
})

test('0013 不会把历史储值卡退款重新补成抵扣', () => {
  const result = reconcileCardHistory({
    cardTransactions: [-10000, 2000],
    payments: [
      { status: '已支付', changeType: '储值卡抵扣', paymentMethod: '储值卡', amount: 10000 },
      { status: '已支付', changeType: '退款', paymentMethod: '储值卡', amount: -2000 },
      bad0011Payment(2000),
    ],
  })

  assert.equal(result.invalidated, 1)
  assert.equal(result.inserted, 0)
  assert.equal(result.settledPrepaid, 8000)
  assert.equal(result.payments.at(-1).status, '已作废')
})

test('0013 不作废不完全匹配坏版 0011 指纹的业务流水', () => {
  const legitimatePayment = {
    ...bad0011Payment(10000),
    operatorEmployeeId: 'EMP-001',
  }
  const result = reconcileCardHistory({
    cardTransactions: [-10000],
    payments: [legitimatePayment],
  })

  assert.equal(result.invalidated, 0)
  assert.equal(result.inserted, 0)
  assert.equal(result.payments[0].status, '已支付')
})

test('0013 作废坏版补款后仅补齐真实扣卡缺口，重跑不重复插入', () => {
  const firstRun = reconcileCardHistory({
    cardTransactions: [-10000],
    payments: [bad0011Payment(10000)],
  })

  assert.equal(firstRun.invalidated, 1)
  assert.equal(firstRun.inserted, 10000)
  assert.equal(firstRun.settledPrepaid, 10000)

  const secondRun = reconcileCardHistory({
    cardTransactions: [-10000],
    payments: firstRun.payments,
  })

  assert.equal(secondRun.invalidated, 0)
  assert.equal(secondRun.inserted, 0)
  assert.equal(secondRun.settledPrepaid, 10000)
  assert.equal(
    secondRun.payments.filter((payment) => payment.note === repair0013Marker).length,
    1,
  )
})

test('0013 保留 0012 已按卡流水净额正确补齐的流水', () => {
  const result = reconcileCardHistory({
    cardTransactions: [-10000, 2000],
    payments: [{
      status: '已支付',
      changeType: '储值卡抵扣',
      paymentMethod: '储值卡',
      amount: 8000,
      note: 'migration:0012:card-transaction-recovery',
    }],
  })

  assert.equal(result.invalidated, 0)
  assert.equal(result.inserted, 0)
  assert.equal(result.settledPrepaid, 8000)
})

test('0013 累计边界分摊守恒、无负尾差，并保留转换行符号', () => {
  for (const [totalCents, weights, expected] of [
    [2, [1, 1, 1, 1], [1, 0, 1, 0]],
    [1, [1, 1, 1], [0, 1, 0]],
    [5, [-80, 100], [-20, 25]],
    [0, [10, 20], [0, 0]],
    [10, [0, 0], [0, 0]],
  ]) {
    const allocated = allocateByCumulativeBoundary(totalCents, weights)
    assert.deepEqual(allocated, expected)
    const expectedTotal = weights.reduce((sum, weight) => sum + weight, 0) === 0
      ? 0
      : totalCents
    assert.equal(allocated.reduce((sum, amount) => sum + amount, 0), expectedTotal)
    if (weights.every((weight) => weight >= 0)) {
      assert.ok(allocated.every((amount) => amount >= 0))
    }
  }
})

test('0013 journal 与 snapshot 由 drizzle generate 连续生成且不夹带 schema 变更', () => {
  const journal = JSON.parse(read('migrations/meta/_journal.json'))
  const snapshot12 = JSON.parse(read('migrations/meta/0012_snapshot.json'))
  const snapshot13 = JSON.parse(read('migrations/meta/0013_snapshot.json'))
  const entry13 = journal.entries.find((entry) => entry.idx === 13)

  assert.equal(entry13.tag, '0013_repair_prepaid_card_history')
  assert.ok(entry13.when > journal.entries.find((entry) => entry.idx === 12).when)
  assert.equal(snapshot13.prevId, snapshot12.id)

  delete snapshot12.id
  delete snapshot12.prevId
  delete snapshot13.id
  delete snapshot13.prevId
  assert.deepEqual(snapshot13, snapshot12)
})

test('0014 将整单最早的成功正向款标为唯一 initial，并同步重建两个业绩视图', () => {
  const schemaSql = read('schema/order.ts')
  const migrationSql = read('migrations/0014_sturdy_sentinels.sql')
  const snapshot14 = JSON.parse(read('migrations/meta/0014_snapshot.json'))
  const definitions = [
    schemaSql,
    migrationSql,
    snapshot14.views['public.sale_order_performance_events'].definition,
    snapshot14.views['public.sale_item_performance_events'].definition,
  ]

  for (const definition of definitions) {
    assert.match(definition, /sop\.status = '已支付'/)
    assert.match(definition, /sop\.amount::numeric > 0/)
    assert.match(definition, /sop\.change_type IN \('首次支付', '回款', '储值卡抵扣'\)/)
    assert.match(definition, /prior\.status = '已支付'/)
    assert.match(definition, /prior\.amount::numeric > 0/)
    assert.match(definition, /COALESCE\(prior\.paid_at, prior\.created_at\),\s*prior\.id/)
    assert.match(definition, /COALESCE\(sop\.paid_at, sop\.created_at\),\s*sop\.id/)
    assert.doesNotMatch(definition, /sop\.change_type = '首次支付'\s+OR/)
  }

  assert.equal((migrationSql.match(/DROP VIEW "public"\."sale_item_performance_events"/g) ?? []).length, 1)
  assert.equal((migrationSql.match(/DROP VIEW "public"\."sale_order_performance_events"/g) ?? []).length, 1)
  assert.equal((migrationSql.match(/CREATE VIEW "public"\."sale_item_performance_events"/g) ?? []).length, 1)
  assert.equal((migrationSql.match(/CREATE VIEW "public"\."sale_order_performance_events"/g) ?? []).length, 1)
})

test('0014 journal/snapshot 在合并迁移链中保持连续', () => {
  const journal = JSON.parse(read('migrations/meta/_journal.json'))
  const snapshot13 = JSON.parse(read('migrations/meta/0013_snapshot.json'))
  const snapshot14 = JSON.parse(read('migrations/meta/0014_snapshot.json'))
  const snapshot28 = JSON.parse(read('migrations/meta/0028_snapshot.json'))
  const entry13 = journal.entries.find((entry) => entry.idx === 13)
  const entry14 = journal.entries.find((entry) => entry.idx === 14)
  const mergeEntry = journal.entries.find((entry) => entry.idx === 28)

  assert.equal(entry14?.tag, '0014_sturdy_sentinels')
  assert.ok(entry14.when > entry13.when)
  assert.equal(snapshot14.prevId, snapshot13.id)
  assert.equal(mergeEntry?.tag, '0028_merge-main-into-dev')
  assert.equal(snapshot28.prevId, snapshot14.id)
  journal.entries.forEach((entry, index) => {
    assert.equal(entry.idx, index, 'journal 索引必须连续，不能重写已发布迁移')
  })

  assert.notDeepEqual(
    snapshot14.views['public.sale_order_performance_events'],
    snapshot13.views['public.sale_order_performance_events'],
  )
  assert.notDeepEqual(
    snapshot14.views['public.sale_item_performance_events'],
    snapshot13.views['public.sale_item_performance_events'],
  )
  for (const viewName of [
    'public.sale_order_performance_events',
    'public.sale_item_performance_events',
  ]) {
    snapshot14.views[viewName] = snapshot13.views[viewName]
  }
  delete snapshot13.id
  delete snapshot13.prevId
  delete snapshot14.id
  delete snapshot14.prevId
  assert.deepEqual(snapshot14, snapshot13, '0014 除两个业绩视图外不应夹带其他 schema 变化')
})
