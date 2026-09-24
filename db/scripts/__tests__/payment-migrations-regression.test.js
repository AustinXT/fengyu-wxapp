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

/**
 * journal 索引守护：守的是「已发布迁移不可被重写/改号」，**不是**「编号必须无空洞」。
 *
 * 0..PUBLISHED_THROUGH 这一段已发布，必须逐位对齐下标；之后新增的条目只要求 idx 严格递增。
 *
 * 放宽的理由（#154）：test 与 dev 两线的编号自 0039 起曾分叉，在一条线上取自然号会与另一线
 * 撞名——本仓已为此踩坑两次。留出的空洞不会在后续产生二次冲突（drizzle 取「上一条 idx + 1」
 * 作下一个号），但会被原来的 idx===index 写法误判成「重写了已发布迁移」。
 *
 * 2026-09-21（PR #204，test→main）：两线编号在这次合并里重新对齐，0..45 段已无空洞，
 * #154 / #182 的两条改号落到 0046 / 0047。`PUBLISHED_THROUGH` 取 45 —— 即 main 上已发布的
 * 最大号；本次新增的两条只受「严格递增」约束，下次发布后可再上调。
 */
const PUBLISHED_THROUGH = 45

function assertJournalIndices(journal) {
  journal.entries.forEach((entry, index) => {
    if (entry.idx <= PUBLISHED_THROUGH) {
      assert.equal(entry.idx, index, '已发布迁移（0..40）的 journal 索引必须连续，不能重写或改号')
    }
    if (index > 0) {
      assert.ok(
        entry.idx > journal.entries[index - 1].idx,
        `journal 索引必须严格递增：第 ${index} 条 idx=${entry.idx} 未大于前一条 ${journal.entries[index - 1].idx}`,
      )
    }
  })
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
  assertJournalIndices(journal)

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

test('0037 款项归属日以 paid_at 初始化，首次支付继续跟随订单', () => {
  const migrationSql = read('migrations/0037_abandoned_talisman.sql')
  const snapshot37 = JSON.parse(read('migrations/meta/0037_snapshot.json'))
  // definitions 只含**当时**的 migration 与 snapshot，不含当前 schema/order.ts：
  // 这条用例守护的是「0037 这条已发布的迁移不被改写」，不是「当前视图长什么样」。
  // 迁移 0041 把视图收敛成直读列后，当前 schema 已不含这里断言的 CASE 分支（那正是它的目的）。
  const definitions = [
    migrationSql,
    snapshot37.views['public.sale_order_performance_events'].definition,
    snapshot37.views['public.sale_item_performance_events'].definition,
  ]

  assert.match(migrationSql, /ADD COLUMN "performance_attribution_date" date/)
  assert.match(migrationSql, /WHERE change_type <> '首次支付'[\s\S]*paid_at IS NOT NULL/)
  assert.match(migrationSql, /CREATE TRIGGER trg_sale_order_payments_performance_attribution/)
  assert.match(migrationSql, /BEFORE INSERT OR UPDATE OF status, paid_at, performance_attribution_date/)
  assert.match(migrationSql, /NEW\.status = '已支付'/)
  assert.match(migrationSql, /NEW\.performance_attribution_date := \(NEW\.paid_at AT TIME ZONE 'Asia\/Shanghai'\)::date/)

  for (const definition of definitions) {
    assert.match(definition, /WHEN change_type = '首次支付' THEN order_performance_attribution_date/)
    assert.match(definition, /payment_performance_attribution_date/)
    assert.match(definition, /\(paid_at AT TIME ZONE 'Asia\/Shanghai'\)::date/)
  }
})

test('0037 journal 与 snapshot 保持连续且只新增款项归属字段和索引', () => {
  const journal = JSON.parse(read('migrations/meta/_journal.json'))
  const snapshot36 = JSON.parse(read('migrations/meta/0036_snapshot.json'))
  const snapshot37 = JSON.parse(read('migrations/meta/0037_snapshot.json'))
  const entry37 = journal.entries.find((entry) => entry.idx === 37)

  assert.equal(entry37?.tag, '0037_abandoned_talisman')
  assert.equal(snapshot37.prevId, snapshot36.id)
  assertJournalIndices(journal)
  const columns = snapshot37.tables['public.sale_order_payments'].columns
  assert.equal(columns.performance_attribution_date.type, 'date')
  assert.equal(columns.performance_attribution_adjusted_at.type, 'timestamp with time zone')
  assert.equal(columns.performance_attribution_adjusted_by.type, 'varchar(30)')
  assert.ok(snapshot37.tables['public.sale_order_payments'].indexes.idx_sop_paid_at_id)
})

test('0038 前向同步混合支付卡流水并让业绩视图跟随现付主流水', () => {
  const migrationSql = read('migrations/0038_sync_mixed_payment_attribution.sql')
  const snapshot38 = JSON.parse(read('migrations/meta/0038_snapshot.json'))
  // 同 0037：不把当前 schema/order.ts 纳入断言，见上一条用例的说明。
  const definitions = [
    migrationSql,
    snapshot38.views['public.sale_order_performance_events'].definition,
    snapshot38.views['public.sale_item_performance_events'].definition,
  ]

  assert.match(migrationSql, /WITH paired_cards AS/)
  assert.match(migrationSql, /primary_payment\.paid_at IS NOT DISTINCT FROM card\.paid_at/)
  assert.match(migrationSql, /CREATE OR REPLACE FUNCTION initialize_payment_performance_attribution_date/)
  assert.match(migrationSql, /NEW\.change_type = '储值卡抵扣'/)
  assert.match(migrationSql, /primary_payment\.paid_at IS NOT DISTINCT FROM NEW\.paid_at/)
  assert.match(migrationSql, /NEW\.change_type IN \('首次支付', '回款'\)/)
  assert.match(migrationSql, /card\.paid_at IS NOT DISTINCT FROM NEW\.paid_at/)

  for (const definition of definitions) {
    assert.match(definition, /LEFT JOIN LATERAL/)
    assert.match(definition, /sop\.change_type = '储值卡抵扣'/)
    assert.match(definition, /primary_payment\.change_type IN \('首次支付', '回款'\)/)
    assert.match(definition, /paired_payment_performance_date/)
  }
})

test('0038 journal 与 snapshot 连续且除两个业绩视图外无 schema 漂移', () => {
  const journal = JSON.parse(read('migrations/meta/_journal.json'))
  const snapshot37 = JSON.parse(read('migrations/meta/0037_snapshot.json'))
  const snapshot38 = JSON.parse(read('migrations/meta/0038_snapshot.json'))
  const entry38 = journal.entries.find((entry) => entry.idx === 38)

  assert.equal(entry38?.tag, '0038_sync_mixed_payment_attribution')
  assert.equal(snapshot38.prevId, snapshot37.id)
  assertJournalIndices(journal)
  for (const viewName of [
    'public.sale_order_performance_events',
    'public.sale_item_performance_events',
  ]) {
    snapshot38.views[viewName] = snapshot37.views[viewName]
  }
  delete snapshot37.id
  delete snapshot37.prevId
  delete snapshot38.id
  delete snapshot38.prevId
  assert.deepEqual(snapshot38, snapshot37, '0038 除两个业绩视图外不应夹带其他 schema 变化')
})

/** 抽出 `CREATE OR REPLACE FUNCTION initialize_...` 到配对 `$$;` 为止的整段。 */
function extractFunctionBody(sql, from = 0) {
  const start = sql.indexOf('CREATE OR REPLACE FUNCTION initialize_payment_performance_attribution_date', from)
  assert.ok(start >= 0, '没找到 initialize_payment_performance_attribution_date 的定义')
  const end = sql.indexOf('$$;', start)
  assert.ok(end > start, '函数体没有收尾的 $$;')
  return sql.slice(start, end + 3)
}

test('0041 业绩视图直读款项归属日期列，写入侧 trigger 与非空约束齐备', () => {
  const schemaSql = read('schema/order.ts')
  const migrationSql = read('migrations/0041_bizarre_wolfpack.sql')
  const snapshot41 = JSON.parse(read('migrations/meta/0041_snapshot.json'))
  const viewDefinitions = [
    schemaSql,
    snapshot41.views['public.sale_order_performance_events'].definition,
    snapshot41.views['public.sale_item_performance_events'].definition,
  ]

  // 把 migration 里的两条 CREATE VIEW 各自切出来单独判 —— 整份 SQL 找一次"直读"是不够的：
  // 只要有一个视图仍是直读，另一个被改回 CASE 也能让全文断言通过。
  const viewStatements = ['sale_item_performance_events', 'sale_order_performance_events'].map((name) => {
    const head = `CREATE VIEW "public"."${name}" AS (`
    const from = migrationSql.indexOf(head)
    assert.ok(from >= 0, `migration 里找不到 ${name} 的 CREATE VIEW`)
    const to = migrationSql.indexOf(');--> statement-breakpoint', from)
    assert.ok(to > from, `${name} 的 CREATE VIEW 没有收尾`)
    return migrationSql.slice(from, to)
  })

  // 收敛的正面证据：直读列
  for (const definition of [...viewDefinitions, ...viewStatements]) {
    assert.match(definition, /sop\.performance_attribution_date AS performance_date/)
  }
  // 收敛的反面证据：0037/0038 那三段回退分支必须从**视图定义**里消失，否则等于口径没收敛。
  // 反面断言不能套整份 migrationSql —— 它的自检块里**故意**保留了整套旧 CASE + LATERAL，
  // 用来和直读列逐行对照，那是本次迁移的安全闸，不是残留；所以这里判的是切出来的两条语句。
  for (const definition of [...viewDefinitions, ...viewStatements]) {
    assert.doesNotMatch(definition, /WHEN change_type = '首次支付' THEN order_performance_attribution_date/)
    assert.doesNotMatch(definition, /paired_payment_performance_date/)
    assert.doesNotMatch(definition, /LEFT JOIN LATERAL/)
  }

  // ① 回填：首次支付行重新对齐订单级（0040 之后又攒下的脱拍行）
  assert.match(migrationSql, /UPDATE sale_order_payments p[\s\S]*SET performance_attribution_date = so\.performance_attribution_date/)
  assert.match(migrationSql, /p\.change_type = '首次支付'[\s\S]*IS DISTINCT FROM so\.performance_attribution_date/)

  // ② fail-closed 自检：有偏差必须 RAISE 回滚，不能降级成告警
  assert.match(migrationSql, /RAISE EXCEPTION[\s\S]*收敛自检失败/)

  // ③ 订单级变更 → 款项行同步下沉为 trigger
  assert.match(migrationSql, /CREATE OR REPLACE FUNCTION sync_order_performance_attribution_to_payments/)
  assert.match(migrationSql, /CREATE OR REPLACE TRIGGER trg_sale_orders_sync_payment_attribution\s*\nAFTER UPDATE OF/)
  // 不能是 DEFERRABLE：那会把同步推迟到 COMMIT，应用层紧接着的回读会读到旧值（静默出错数）。
  // 按字符数开窗口不可靠（DEFERRABLE 的语法位在 EXECUTE FUNCTION 前，实测距 trigger 名 490+ 字符），
  // 直接把整条 CREATE TRIGGER 语句切出来判。
  const trgStart = migrationSql.indexOf('CREATE OR REPLACE TRIGGER trg_sale_orders_sync_payment_attribution')
  assert.ok(trgStart >= 0)
  const trgStmt = migrationSql.slice(trgStart, migrationSql.indexOf(';', trgStart) + 1)
  assert.match(trgStmt, /EXECUTE FUNCTION sync_order_performance_attribution_to_payments\(\)/)
  assert.doesNotMatch(trgStmt, /DEFERRABLE/)
  // ④ 给 0040 的 BEFORE trigger 补行锁，堵住「改期未提交 + 首次支付入账」的脏读
  assert.match(migrationSql, /CREATE OR REPLACE FUNCTION initialize_payment_performance_attribution_date/)
  // 必须是 FOR SHARE：FOR KEY SHARE 与 FOR NO KEY UPDATE 不冲突，挡不住普通的 UPDATE sale_orders
  assert.match(migrationSql, /WHERE so\.sale_order_id = NEW\.sale_order_id\s*\n\s*FOR SHARE;/)
  assert.match(migrationSql, /FOR SHARE OF so;/)
  // 注意只判**语句**，别判整文 —— 迁移注释里专门解释了"为什么不能用 FOR KEY SHARE"
  assert.doesNotMatch(migrationSql, /FOR KEY SHARE\s*(;|OF)/)
  // 迁移期间不许把业务表锁死
  assert.match(migrationSql, /SET LOCAL lock_timeout/)

  // 0041 重定义 0040 的 initialize_payment_performance_attribution_date()，只为给两处读
  // sale_orders 的 SELECT 补 FOR SHARE（**不能是 FOR KEY SHARE**，理由见迁移 0041 的 ④ 段），
  // 外加胜出者判定。函数体其余部分必须与 0040 **逐字相同** —— 否则就是在
  // "顺手改了别的逻辑"，而 0040 的行为没有任何其他地方在守。
  const fn0040 = extractFunctionBody(read('migrations/0040_payment_attribution_date_always_set.sql'))
  const fn0041 = extractFunctionBody(migrationSql, migrationSql.lastIndexOf(
    'CREATE OR REPLACE FUNCTION initialize_payment_performance_attribution_date',
  ))
  // 0041 相对 0040 只允许这三处改动，逐一剥掉后必须与 0040 逐字相同。
  // 任何第四处差异都说明"顺手改了别的逻辑"，而 0040 的行为没有其他地方在守。
  const normalized = fn0041
    // ① 首次支付分支的加锁读
    .replace(/\n\s*-- FOR SHARE：[^\n]*\n/, '\n')
    .replace(/\n\s*FOR SHARE;/, ';')
    // ② 储值卡配对分支的加锁读
    .replace(/\n\s*-- 同上：这一支[\s\S]*?\n\s*FOR SHARE OF so;/, ';')
    // ③ 反向同步块的「配对胜出者」判定（与自检②/I6b 的 ORDER BY 对齐）
    .replace(/\n\s*--\n\s*-- NOT EXISTS 那一段是「胜出者」判定：[\s\S]*?三处口径必须一致。/, '')
    .replace(/\n\s*AND NOT EXISTS \(\n\s*SELECT 1\n\s*FROM sale_order_payments better[\s\S]*?\n\s*\) THEN/, ' THEN')
  assert.equal(
    normalized,
    fn0040,
    '0041 里那份函数体除「两处加 FOR SHARE + 胜出者判定」外必须与 0040 逐字一致',
  )
  // 顺序是硬约束：卡行必须排在首次支付之前，否则 BEFORE trigger 的反向同步会撞
  // 「tuple to be updated was already modified by an operation triggered by the current command」
  const cardIdx = migrationSql.indexOf("UPDATE sale_order_payments card")
  const firstIdx = migrationSql.indexOf("UPDATE sale_order_payments first_payment")
  assert.ok(cardIdx > 0 && firstIdx > 0, 'trigger 函数体内两条 UPDATE 都要在')
  assert.ok(cardIdx < firstIdx, '储值卡抵扣行必须先于首次支付行更新')

  // 非空约束（用 CHECK 而非 SET NOT NULL：见 schema/order.ts 该约束处的说明）
  assert.match(migrationSql, /ADD CONSTRAINT "chk_sop_attribution_date_present" CHECK/)
  assert.match(schemaSql, /chk_sop_attribution_date_present/)
  assert.ok(
    snapshot41.tables['public.sale_order_payments'].checkConstraints?.chk_sop_attribution_date_present,
    'snapshot 必须记录该 CHECK 约束',
  )
  // 该列保持 nullable：notNull 会让 drizzle 的 $inferInsert 变必填，三端 INSERT 都得自己算归属日期
  assert.equal(
    snapshot41.tables['public.sale_order_payments'].columns.performance_attribution_date.notNull,
    false,
  )
})

test('0041 journal 与 snapshot 连续且除两个业绩视图与该 CHECK 外无 schema 漂移', () => {
  const journal = JSON.parse(read('migrations/meta/_journal.json'))
  const snapshot40 = JSON.parse(read('migrations/meta/0040_snapshot.json'))
  const snapshot41 = JSON.parse(read('migrations/meta/0041_snapshot.json'))
  const entry41 = journal.entries.find((entry) => entry.idx === 41)

  assert.equal(entry41?.tag, '0041_bizarre_wolfpack')
  assert.equal(snapshot41.prevId, snapshot40.id)
  assertJournalIndices(journal)
  for (const viewName of [
    'public.sale_order_performance_events',
    'public.sale_item_performance_events',
  ]) {
    snapshot41.views[viewName] = snapshot40.views[viewName]
  }
  delete snapshot41.tables['public.sale_order_payments'].checkConstraints
    .chk_sop_attribution_date_present
  delete snapshot40.id
  delete snapshot40.prevId
  delete snapshot41.id
  delete snapshot41.prevId
  assert.deepEqual(snapshot41, snapshot40, '0041 除两个业绩视图与该 CHECK 外不应夹带其他 schema 变化')
})
