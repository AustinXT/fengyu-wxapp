import test from 'node:test'
import assert from 'node:assert/strict'

import {
  extractJavaScriptStringLiterals,
  lintSource,
} from '../lint-cas-guards.mjs'

test('完整模板字面量中的 CAS 超过 600 字符仍可识别', () => {
  const padding = Array.from({ length: 40 }, (_, index) => `column_${index} = ${index}`).join(',\n')
  const source = `await tx.execute(sql\`UPDATE sale_orders
    SET status = \${nextStatus},
        ${padding}
    WHERE sale_order_id = \${saleOrderId}
      AND status = \${previousStatus}\`)
  `

  assert.ok(source.indexOf('AND status') - source.indexOf('UPDATE') > 600)
  assert.deepEqual(lintSource(source), [])
})

test('同长度但缺少状态谓词时报告 UPDATE 所在行', () => {
  const padding = 'note = note,\n'.repeat(80)
  const source = `const result = sql\`
    UPDATE sale_orders
    SET status = '已支付',
        ${padding}
    WHERE sale_order_id = 'ORDER-1'
  \``

  assert.deepEqual(lintSource(source, 'orders.ts'), [{
    file: 'orders.ts',
    line: 2,
    table: 'sale_orders',
  }])
})

test('后续另一条有 CAS 的 SQL 不能替前一条放行', () => {
  const source = [
    "db.query(\"UPDATE sale_orders SET status = '已支付' WHERE sale_order_id = 'A'\")",
    "db.query(\"UPDATE sale_orders SET status = '已关闭' WHERE sale_order_id = 'B' AND status = '待支付'\")",
  ].join('\n')

  assert.deepEqual(lintSource(source, 'two-statements.js'), [{
    file: 'two-statements.js',
    line: 1,
    table: 'sale_orders',
  }])
})

test('模板插值不截断 SQL，单行引号 SQL 也能识别', () => {
  const source = [
    'tx.execute(sql`UPDATE service_orders SET status = ${next} WHERE id = ${id} AND status IN (${allowed})`)',
    "db.query('UPDATE appointments SET status = \\'已完成\\' WHERE appointment_id = $1 AND status = \\'进行中\\'')",
  ].join('\n')

  assert.deepEqual(lintSource(source), [])
  assert.equal(extractJavaScriptStringLiterals(source).length, 2)
})

test('allocation_status 与 commission_status 使用各自前置态守卫', () => {
  const guarded = [
    "db.query(\"UPDATE sale_order_payments SET allocation_status = '已分配' WHERE id = $1 AND allocation_status IN ('待分配', '已分配')\")",
    "db.query(\"UPDATE service_orders SET commission_status = '已分配' WHERE service_order_id = $1 AND commission_status = '待分配'\")",
  ].join('\n')
  assert.deepEqual(lintSource(guarded), [])

  const missing = [
    "db.query(\"UPDATE sale_order_payments SET allocation_status = '已分配' WHERE id = $1\")",
    "db.query(\"UPDATE service_orders SET commission_status = '已分配' WHERE service_order_id = $1\")",
  ].join('\n')
  assert.deepEqual(lintSource(missing, 'state-columns.js'), [
    { file: 'state-columns.js', line: 1, table: 'sale_order_payments' },
    { file: 'state-columns.js', line: 2, table: 'service_orders' },
  ])
})

test('NOT NULL 恒真谓词不能冒充状态前置态守卫', () => {
  const source = "db.query(\"UPDATE sale_orders SET status = '已支付' WHERE sale_order_id = $1 AND status IS NOT NULL\")"

  assert.deepEqual(lintSource(source, 'not-null.js'), [
    { file: 'not-null.js', line: 1, table: 'sale_orders' },
  ])
})

test('双引号表名和状态列不会绕过检查', () => {
  const source = [
    'db.execute(sql`UPDATE "sale_orders" SET "status" = ${next} WHERE sale_order_id = ${id}`)',
    'db.execute(sql`UPDATE "public"."sale_orders" SET "allocation_status" = ${next} WHERE sale_order_id = ${id} AND "allocation_status" IS NULL`)',
    'db.query("UPDATE \\"service_orders\\" SET \\"commission_status\\" = \'已分配\' WHERE service_order_id = $1")',
  ].join('\n')

  assert.deepEqual(lintSource(source, 'quoted.ts'), [
    { file: 'quoted.ts', line: 1, table: 'sale_orders' },
    { file: 'quoted.ts', line: 3, table: 'service_orders' },
  ])
})

test('源码与 SQL 注释中的伪 UPDATE 不参与检查', () => {
  const source = [
    '// UPDATE sale_orders SET status = x WHERE sale_order_id = y',
    'const note = "plain text"',
    'db.query(`SELECT \'UPDATE sale_orders SET status = x WHERE id = y\'`)',
  ].join('\n')

  assert.deepEqual(lintSource(source), [])
})

test('CAS-EXEMPT 仅豁免紧邻的当前 SQL 字面量', () => {
  const source = [
    '// CAS-EXEMPT: legacy state repair',
    "db.query(\"UPDATE sale_orders SET status = '已支付' WHERE sale_order_id = 'A'\")",
    '',
    '',
    '',
    "db.query(\"UPDATE sale_orders SET status = '已关闭' WHERE sale_order_id = 'B'\")",
  ].join('\n')

  assert.deepEqual(lintSource(source, 'exempt.js'), [{
    file: 'exempt.js',
    line: 6,
    table: 'sale_orders',
  }])
})

test('一条 CAS-EXEMPT 注释不能连续豁免两条 SQL', () => {
  const source = [
    '// CAS-EXEMPT: legacy state repair',
    "db.query(\"UPDATE sale_orders SET status = '已支付' WHERE sale_order_id = 'A'\")",
    "db.query(\"UPDATE sale_orders SET status = '已关闭' WHERE sale_order_id = 'B'\")",
  ].join('\n')

  assert.deepEqual(lintSource(source, 'adjacent-exempt.js'), [{
    file: 'adjacent-exempt.js',
    line: 3,
    table: 'sale_orders',
  }])
})

test('同一源码行的第二条 SQL 也不能复用上一行 CAS-EXEMPT', () => {
  const source = [
    '// CAS-EXEMPT: legacy state repair',
    "db.query(\"UPDATE sale_orders SET status = '已支付' WHERE sale_order_id = 'A'\"); db.query(\"UPDATE sale_orders SET status = '已关闭' WHERE sale_order_id = 'B'\")",
  ].join('\n')

  assert.deepEqual(lintSource(source, 'same-line-exempt.js'), [{
    file: 'same-line-exempt.js',
    line: 2,
    table: 'sale_orders',
  }])
})
