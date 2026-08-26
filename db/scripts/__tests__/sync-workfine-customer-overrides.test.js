'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const { readFileSync } = require('node:fs')
const { resolve } = require('node:path')

const source = readFileSync(resolve(__dirname, '../sync-workfine.js'), 'utf8')

test('顾客同步三条更新路径都保留人工覆盖字段', () => {
  const fields = [
    'customer_source',
    'birthday',
    'occupation',
    'is_married',
    'skin_issue',
    'wellness_preference',
  ]

  for (const field of fields) {
    const guard = new RegExp(`'${field}' = ANY\\(c\\.workfine_override_fields\\)`, 'g')
    assert.equal(
      (source.match(guard) || []).length,
      3,
      `${field} 应在 customer_id 预更新、phone UPSERT、无 phone 更新三条路径中受保护`,
    )
  }
})

test('手机号 UPSERT 使用目标表别名读取覆盖列表', () => {
  assert.match(source, /INSERT INTO client_wechat_users AS c\s*\(/)
  assert.match(source, /ELSE EXCLUDED\.customer_source END/)
})
