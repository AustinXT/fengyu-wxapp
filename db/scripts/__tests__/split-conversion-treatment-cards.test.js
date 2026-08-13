'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')

const {
  generatedSaleItemId,
  proportionalCents,
  splitCapacity,
  splitCents,
} = require('../split-conversion-treatment-cards')

test('splitCents 精确守恒并由末张吸收分角尾差', () => {
  assert.deepEqual(splitCents(1001, 3), [333, 333, 335])
  assert.deepEqual(splitCents(-1001, 3), [-333, -333, -335])
  assert.equal(splitCents(1001, 3).reduce((sum, value) => sum + value, 0), 1001)
})

test('splitCapacity 按实体卡容量顺序分配已付次数', () => {
  assert.deepEqual(splitCapacity(14, 5, 3), [5, 5, 4])
  assert.deepEqual(splitCapacity(0, 5, 3), [0, 0, 0])
  assert.throws(() => splitCapacity(16, 5, 3), /CAPACITY_OVERFLOW/)
})

test('proportionalCents 按 receipt 权重拆分且保持负数总额', () => {
  const parts = proportionalCents(-1001, [400, 600])
  assert.deepEqual(parts, [-400, -601])
  assert.equal(parts.reduce((sum, value) => sum + value, 0), -1001)
})

test('proportionalCents 在零金额 receipt 上回退为均分', () => {
  assert.deepEqual(proportionalCents(5, [0, 0]), [2, 3])
})

test('生成的 sale_item_id 确定、互异且不超过 varchar(30)', () => {
  const first = generatedSaleItemId('XSLSH-WX-202608110174', 1)
  const second = generatedSaleItemId('XSLSH-WX-202608110174', 2)
  assert.equal(first, generatedSaleItemId('XSLSH-WX-202608110174', 1))
  assert.notEqual(first, second)
  assert.ok(first.length <= 30)
  assert.match(first, /^CV-[A-F0-9]{20}-\d{3}$/)
})
