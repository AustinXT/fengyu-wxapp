/**
 * #154：`verify-quantity-split.js` 的 dry-run 与迁移 0043 的回填口径必须同源。
 *
 * 为什么需要这个守护：dry-run 的**唯一用途**就是替迁移预演。脚本注释里写着
 * 「这三个分支必须与迁移 0043 的 WHERE 字面同口径」，但那只是一句注释 ——
 * 改了迁移不改脚本，测试照样全绿，而 dry-run 会给出与真实迁移不同的结论
 * （报「全部通过」，迁移却 RAISE 回滚）。本仓反复踩的就是这种「硬编码清单无守护」。
 *
 * 不连库，纯字面量比对，随 `npm run db:test` 跑。
 */

'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

const ROOT = path.resolve(__dirname, '../../..')
const MIGRATION = path.join(ROOT, 'db/migrations/0043_split_quantity_semantics.sql')
const VERIFY = path.join(ROOT, 'db/scripts/verify-quantity-split.js')

const read = (p) => fs.readFileSync(p, 'utf8')
/** 压平空白：两边缩进不同（SQL 在 JS 模板串里），只比结构不比排版。 */
const flat = (s) => s.replace(/\s+/g, ' ')

test('两份文件都还在（改名/删除必须同步本守护）', () => {
  assert.ok(fs.existsSync(MIGRATION), '迁移 0043 不存在')
  assert.ok(fs.existsSync(VERIFY), 'verify-quantity-split.js 不存在')
})

test('dry-run 的取行范围与迁移回填的 WHERE 三分支同口径', () => {
  const migration = flat(read(MIGRATION))
  const verify = flat(read(VERIFY))

  // 三个分支缺任何一个，dry-run 都会漏掉一类行 → 预演结论与迁移真实行为分叉
  const BRANCHES = [
    // ① picked_up 非零
    'COALESCE(si.picked_up_quantity, 0) <> 0',
    // ② 有提货记录
    'EXISTS (SELECT 1 FROM pickup_records pr WHERE pr.sale_item_id = si.sale_item_id)',
    // ③ 有未关闭转换单的转出行
    "out_item.ref_sale_item_id = si.sale_item_id AND out_item.item_direction = '转出'"
      + " AND out_item.product_type = '家居产品' AND conv_order.status <> '已关闭'",
  ]
  for (const branch of BRANCHES) {
    assert.ok(migration.includes(branch), `迁移缺少取行分支：${branch}`)
    assert.ok(verify.includes(branch), `verify 脚本缺少取行分支：${branch}`)
  }
})

test('两边的三语义拆分口径同源（物理提货 / 已转换 / 已支付退款判据）', () => {
  const migration = flat(read(MIGRATION))
  const verify = flat(read(VERIFY))

  const SHARED = [
    // 物理提货
    'SELECT SUM(pr.pickup_quantity)::int FROM pickup_records pr WHERE pr.sale_item_id = si.sale_item_id',
    // 已转换（只排除「已关闭」）
    'SELECT SUM(out_item.quantity)::int FROM sale_items out_item',
    // 已支付退款判据
    "sop.change_type = '退款' AND sop.status = '已支付'",
  ]
  for (const frag of SHARED) {
    assert.ok(migration.includes(frag), `迁移缺少口径片段：${frag}`)
    assert.ok(verify.includes(frag), `verify 脚本缺少口径片段：${frag}`)
  }
})

test('回填的四个分支判据两边一致（含「有提货记录的无退款残差」必须拦下）', () => {
  const migration = flat(read(MIGRATION))
  const verify = flat(read(VERIFY))

  // 迁移侧：前置断言拦「residual > 0 且无退款 且有提货记录」
  assert.ok(
    migration.includes(
      'old_settled - picked_phys - conv > 0 AND NOT has_paid_refund AND has_pickup_records',
    ),
    '迁移的前置断言没有拦「有提货记录的无退款残差」—— 该类行并回 picked_up 会与事后断言 2 互斥',
  )
  // 迁移侧：只有「没有提货记录」时残差才留在 picked_up
  assert.ok(
    migration.includes(
      's.residual > 0 AND NOT s.has_paid_refund AND NOT s.has_pickup_records',
    ),
    '迁移的回填分支没有排除「有提货记录」的行',
  )

  // 脚本侧：同两个判据，用 JS 表达
  assert.ok(
    verify.includes('r.residual > 0 && !r.has_paid_refund && r.has_pickup_records'),
    'verify 脚本没有把「有提货记录的无退款残差」报成阻断项',
  )
  assert.ok(
    verify.includes('r.residual > 0 && !r.has_paid_refund && !r.has_pickup_records'),
    'verify 脚本的「历史提货未留记录」分支判据与迁移不一致',
  )
})

test('迁移后校验与 cron C5 是同一条不变量（都由 pickup_records 聚合驱动）', () => {
  const verify = flat(read(VERIFY))
  const cron = flat(read(path.join(
    ROOT, 'fengyu-admin/src/cron/steps/audit-refund-cascade-coverage.ts',
  )))

  // 两边都必须是「聚合驱动 JOIN」而不是「全表扫 + EXISTS + 相关子查询」：
  // 前者让「无提货记录的行豁免」由 JOIN 天然表达，两处口径不会各自漂移。
  for (const [name, src] of [['verify 脚本', verify], ['cron C5', cron]]) {
    assert.ok(
      /SELECT sale_item_id, SUM\(pickup_quantity\)(?:::int)? AS \w+ FROM pickup_records GROUP BY sale_item_id/.test(src),
      `${name} 的 picked_up 守恒校验不是聚合驱动`,
    )
    assert.ok(
      !/EXISTS \(SELECT 1 FROM pickup_records pr WHERE pr\.sale_item_id = s(?:i)?\.sale_item_id\)\s*AND COALESCE/.test(src),
      `${name} 回退到了 EXISTS + 相关子查询的写法`,
    )
  }
})

test('「已结算 <= 购买件数」的权威表达是 CHECK 约束，三处引用同名', () => {
  const schema = read(path.join(ROOT, 'db/schema/order.ts')).replace(/\s+/g, ' ')
  const migration = flat(read(MIGRATION))
  const cron = flat(read(path.join(
    ROOT, 'fengyu-admin/src/cron/steps/audit-refund-cascade-coverage.ts',
  )))

  // schema 是唯一权威来源；迁移由 drizzle 从它生成
  assert.ok(
    schema.includes('"chk_sale_item_settled_le_quantity"'),
    'schema/order.ts 少了 chk_sale_item_settled_le_quantity —— 写入点的 8 份 WHERE 守卫是手抄，'
    + '漏一处就是资损，约束才是这条不变量不可绕过的表达',
  )
  assert.ok(
    migration.includes('ADD CONSTRAINT "chk_sale_item_settled_le_quantity" CHECK'),
    '迁移 0043 少了该约束（schema 改了但没重新 generate？）',
  )
  // 约束必须在回填之前生效：此时 refunded/converted 恒为 0、picked_up <= quantity，必然通过
  assert.ok(
    migration.indexOf('ADD CONSTRAINT "chk_sale_item_settled_le_quantity"')
      < migration.indexOf('#154：picked_up_quantity 三语义拆列的历史数据回填'),
    '约束必须在回填段之前（drizzle 生成段内），否则语义与注释不符',
  )
  // C5b 降级为二道保险，注释不得再自称「约束的替身」
  assert.ok(
    !cron.includes('这条巡检就是那个约束的替身'),
    'cron C5b 的注释还停在「没有约束」的旧状态',
  )
})

test('两个新列是 NOT NULL（全新列无历史 NULL，可空只会让每个读取点背 COALESCE）', () => {
  const schema = read(path.join(ROOT, 'db/schema/order.ts')).replace(/\s+/g, ' ')
  const migration = flat(read(MIGRATION))
  for (const col of ['refunded_quantity', 'converted_quantity']) {
    assert.ok(
      schema.includes(`integer("${col}").notNull().default(0)`),
      `schema 的 ${col} 不是 notNull`,
    )
    assert.ok(
      migration.includes(`ADD COLUMN "${col}" integer DEFAULT 0 NOT NULL`),
      `迁移的 ${col} 不是 NOT NULL`,
    )
  }
})
