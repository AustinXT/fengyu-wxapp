'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

const migrationsDir = path.resolve(__dirname, '../../migrations')

test('品项业绩残差以全部已支付 receipt 的有符号净额计算', () => {
  const sql = fs.readFileSync(
    path.join(migrationsDir, '0010_flaky_thunderbolt_ross.sql'),
    'utf8',
  )
  const receiptTotals = sql.match(/receipt_totals AS \(([\s\S]*?)\),\n  residuals AS/)

  assert.ok(receiptTotals, '应存在 receipt_totals CTE')
  assert.match(receiptTotals[1], /SUM\(amount\)::numeric\(10, 2\)/)
  assert.doesNotMatch(receiptTotals[1], /FILTER|change_type/)
})

test('储值卡语义迁移先补齐已结清历史实付流水再重算订单快照', () => {
  const sql = fs.readFileSync(
    path.join(migrationsDir, '0011_crazy_pestilence.sql'),
    'utf8',
  )
  const gapInsertAt = sql.indexOf('INSERT INTO sale_order_payments')
  const snapshotRecalcAt = sql.indexOf('WITH payment_totals AS')

  assert.ok(gapInsertAt > 0, '应补齐历史储值卡流水')
  assert.ok(snapshotRecalcAt > gapInsertAt, '应在订单快照重算前补流水')
  assert.match(sql, /old_prepaid - settled_prepaid/)
  assert.match(sql, /so\.status IN \('已支付', '已完成'\)/)
  assert.match(sql, /'储值卡抵扣'::payment_change_type/)
  assert.match(sql, /'已支付'::payment_flow_status/)
  assert.match(sql, /change_type = '退款' AND sop\.payment_method = '储值卡'/)
})
