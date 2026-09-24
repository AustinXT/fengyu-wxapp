/**
 * #154：`verify-quantity-split.js` 的 dry-run 与迁移 0046 的回填口径必须同源。
 *
 * 为什么需要这个守护：dry-run 的**唯一用途**就是替迁移预演。脚本注释里写着
 * 「这三个分支必须与迁移 0046 的 WHERE 字面同口径」，但那只是一句注释 ——
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
const MIGRATION = path.join(ROOT, 'db/migrations/0046_split_quantity_semantics.sql')
const VERIFY = path.join(ROOT, 'db/scripts/verify-quantity-split.js')

const read = (p) => fs.readFileSync(p, 'utf8')
/** 压平空白：两边缩进不同（SQL 在 JS 模板串里），只比结构不比排版。 */
const flat = (s) => s.replace(/\s+/g, ' ')

test('两份文件都还在（改名/删除必须同步本守护）', () => {
  assert.ok(fs.existsSync(MIGRATION), '迁移 0046 不存在')
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

test('回填的归因判据两边一致：必须落到本行的退款实据，且无任何豁免分支', () => {
  const migration = flat(read(MIGRATION))
  const verify = flat(read(VERIFY))

  // 只看「订单上有没有退款」会把同单**他行**的退款错安到本行头上（双谱系评审命中）。
  // 三条实据任一成立即可：整单已退款 / ref_sale_item_id 指向本行 / note.items 含本行。
  for (const [name, src] of [['迁移', migration], ['verify 脚本', verify]]) {
    assert.ok(src.includes("o.status = '已退款'") || src.includes("order_status = '已退款'"),
      `${name} 缺少「整单已退款」实据`)
    assert.ok(src.includes('sop.ref_sale_item_id = si.sale_item_id'),
      `${name} 缺少「ref_sale_item_id 指向本行」实据`)
    assert.ok(src.includes("elem ->> 'refSaleItemId' = si.sale_item_id"),
      `${name} 缺少「note.items 含本行」实据`)
  }

  // 初版留过一条「无退款残差 → 留在 picked_up」的口子，它让 AC4 不再是全量不变量、
  // 并迫使 cron C5 为这类行开永久豁免。现在一律拦下，任何回潮都要在这里红。
  assert.ok(
    !/NOT has_paid_refund AND NOT has_pickup_records/.test(migration),
    '迁移回潮到了「历史提货未留记录」豁免分支 —— 它会让 AC4 不成立',
  )
  assert.ok(
    migration.includes('NOT has_item_refund_evidence'),
    '迁移的前置断言没有按「本行退款实据」拦截无从解释的残差',
  )
})

test('迁移后校验与 cron C5 是同一条**全量**不变量（都由 pickup_records 聚合驱动、无豁免）', () => {
  const verify = flat(read(VERIFY))
  const cron = flat(read(path.join(
    ROOT, 'fengyu-admin/src/cron/steps/audit-refund-cascade-coverage.ts',
  )))
  const migration = flat(read(MIGRATION))

  for (const [name, src] of [['verify 脚本', verify], ['cron C5', cron], ['迁移事后断言', migration]]) {
    assert.ok(
      /SELECT sale_item_id, SUM\(pickup_quantity\)(?:::int)? AS \w+ FROM pickup_records GROUP BY sale_item_id/.test(src),
      `${name} 的 picked_up 守恒校验不是聚合驱动`,
    )
    // 用 INNER JOIN 会把「有 picked_up 但零 pickup_records」的损坏行整片漏掉 ——
    // 而那正是「删提货记录」出错后的形态，也正是 C5 存在的理由。
    assert.ok(
      /(FULL|LEFT) JOIN/.test(src),
      `${name} 用了 INNER JOIN，会漏掉「有 picked_up 但零提货记录」的损坏行`,
    )
    assert.ok(
      !/EXISTS \(SELECT 1 FROM pickup_records pr WHERE pr\.sale_item_id = s(?:i)?\.sale_item_id\)\s*AND COALESCE/.test(src),
      `${name} 回退到了 EXISTS 豁免写法`,
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
    '迁移 0046 少了该约束（schema 改了但没重新 generate？）',
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

test('note→jsonb 守门写法与全仓四端约定一致（不得单独加 btrim）', () => {
  // `note LIKE '{%'` 是四端 14 处的既定写法，由 cross-end-sql-snapshot 的
  // 「四端 note→jsonb 守门」一项守护。第 4 轮评审建议把这两处改 btrim 兜住前导空格 ——
  // 不采纳：单独改会让这两处偏离四端约定，而副本漂移是本仓最高频的 P1 源；
  // 实测 prod 235 条退款 note 全合法、0 条带前导空格。要改就四端一起改。
  for (const [name, file] of [['迁移 0046', MIGRATION], ['verify 脚本', VERIFY]]) {
    const src = read(file)
    assert.ok(
      src.includes("CASE WHEN sop.note LIKE '{%'"),
      `${name} 的 note 守门写法偏离了四端约定`,
    )
    assert.ok(
      !src.includes('btrim(sop.note)'),
      `${name} 单独加了 btrim —— 要改请四端一起改，否则就是副本漂移`,
    )
  }
})
