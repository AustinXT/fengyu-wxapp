'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')

const {
  processRows,
  toTimestamp,
  toWorkfineBusinessDate,
} = require('../import-workfine-legacy')

test('MSSQL Date 按 UTC 分量还原 WorkFine 原始墙上时间与业务日期', () => {
  const driverDate = new Date(Date.UTC(2026, 7, 17, 16, 30, 45, 123))

  assert.equal(toTimestamp(driverDate), '2026-08-17T16:30:45.123+08:00')
  assert.equal(toWorkfineBusinessDate(driverDate), '2026-08-17')
})

test('晚于 16 点的 WorkFine 日期不会因再次转上海时区归到次日', () => {
  const { rowsToInsert } = processRows(
    [{
      legacy_order_no: 'WF-DATE-001',
      sale_date: new Date(Date.UTC(2026, 7, 17, 23, 59, 59)),
      market_name: '测试市场',
      store_name: '测试门店',
      legacy_customer_id: 'C-1',
      customer_name: '测试顾客',
      amount: 100,
      phone: '13800000000',
    }],
    {
      existingIds: new Set(),
      storeMap: { 测试门店: 'STORE-1' },
      phoneMap: { 13800000000: 'USER-1' },
      customerIdMap: {},
    },
  )

  assert.equal(rowsToInsert[0].saleOrderDatetime, '2026-08-17T23:59:59.000+08:00')
  assert.equal(rowsToInsert[0].performanceAttributionDate, '2026-08-17')
})

test('SQL CONVERT 返回的墙上时间字符串直接保留日期和上海偏移', () => {
  assert.equal(toTimestamp('2026-08-17 16:00:00.5'), '2026-08-17T16:00:00.500+08:00')
  assert.equal(toWorkfineBusinessDate('2026-08-17 16:00:00.5'), '2026-08-17')
})
