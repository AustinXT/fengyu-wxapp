/**
 * 提货冻结出库金额的 DB 兜底回归（issue #341）
 *
 * 在真 PG 上证明两件事：
 *   1. `chk_pickup_amount_frozen`：冻结单价与出库金额两列同生同灭，金额必须 = ROUND(冻结单价 × 提货数量, 2)，
 *      写入端算错、只写一列都会被拒；
 *      `trg_pickup_records_fill_frozen_amount`：写入端两列都没带（发版空档的旧版本 / 新写入口）时按
 *      sale_items.unit_real_price 自动补齐，不会再写出与历史行无法区分的双 NULL；
 *   2. 提货生成的 GCK（院顾客产品出库）明细只写批次价格快照、不写 actual_unit_price 时，
 *      `inventory_set_doc_item_amount` 按 门店成本 → 市场结算价 → 供应链成本 算 amount，赠送批次记 0
 *      ——出库成本与售价口径的出库金额分两列存。
 *
 * 运行（需要一个已 apply 全部 migration 的库；绝不要指向业务库）：
 *
 *   docker run -d --name pg-verify-341 -e POSTGRES_PASSWORD=test -e POSTGRES_DB=verify341 \
 *     -p 54403:5432 postgres:16
 *   DATABASE_URL="postgresql://postgres:test@localhost:54403/verify341" \
 *     bash db/scripts/bootstrap-from-zero.sh
 *   PICKUP_PG_TEST_URL="postgresql://postgres:test@localhost:54403/verify341" \
 *     node --test db/scripts/__tests__/pickup-amount.pg.test.js
 *   docker rm -f pg-verify-341
 *
 * 未设变量时整个套件 skip。每条用例在自己的事务里 seed、断言、ROLLBACK，不留任何数据
 * （夹具 id 带 T341PG_ 前缀）。
 */

const test = require('node:test')
const assert = require('node:assert/strict')
const { Client } = require('pg')

const URL = process.env.PICKUP_PG_TEST_URL

/** 业务库名单：连上之后问库名，命中即拒（IP 黑名单是 fail-open 的）。 */
const FORBIDDEN_DB_NAMES = ['fengyu_wxapp', 'fengyu_e2e', 'fengyu']

const P = 'T341PG_'

// 元守护（不连库，db:test 常跑）：迁移里 trigger 的取值列钉死 sale_items.unit_real_price
test('0054 trigger 从 sale_items.unit_real_price 取冻结单价（不是 unit_price）', () => {
  const fs = require('node:fs')
  const path = require('node:path')
  const migration = fs.readFileSync(path.resolve(__dirname, '../../migrations/0054_pickup_frozen_amount.sql'), 'utf8')
  const body = migration.slice(migration.indexOf('CREATE OR REPLACE FUNCTION pickup_records_fill_frozen_amount()'))
  assert.match(body, /SELECT si\.unit_real_price INTO NEW\.pickup_unit_price\s+FROM sale_items si\s+WHERE si\.sale_item_id = NEW\.sale_item_id;/)
  assert.doesNotMatch(body, /\bunit_price\b/)
})

// 元守护（不连库）：历史行不回填（拍板 Q4=B）—— 0054 不得对 pickup_records 做 UPDATE / INSERT 回填
test('0054 不回填存量提货记录（无 UPDATE / INSERT pickup_records）', () => {
  const fs = require('node:fs')
  const path = require('node:path')
  const migration = fs.readFileSync(path.resolve(__dirname, '../../migrations/0054_pickup_frozen_amount.sql'), 'utf8')
    .split('\n').filter((line) => !/^\s*--/.test(line)).join('\n')
  assert.doesNotMatch(migration, /\bUPDATE\s+(?:ONLY\s+)?(?:"?public"?\s*\.\s*)?"?pickup_records"?/i)
  assert.doesNotMatch(migration, /\bINSERT\s+INTO\s+(?:"?public"?\s*\.\s*)?"?pickup_records"?/i)
  // trigger 只挂 INSERT：挂到 UPDATE 上会在任何改写（如顾客合并改 client_user_id）时补齐历史行
  assert.match(migration, /BEFORE INSERT ON pickup_records\s*\n\s*FOR EACH ROW/)
  assert.doesNotMatch(migration, /BEFORE\s+(?:INSERT\s+OR\s+)?UPDATE/i)
})

// 元守护（不连库，db:test 常跑）：本套件缺 env 会整套 skip，CI 必须真的带着 PICKUP_PG_TEST_URL 跑它，
// 否则 DB 层语义在 CI 零覆盖（#341 评审 round-1）。
test('CI workflow 带 PICKUP_PG_TEST_URL 执行本套件', () => {
  const fs = require('node:fs')
  const path = require('node:path')
  const workflow = fs.readFileSync(path.resolve(__dirname, '../../../.github/workflows/db-script-tests.yml'), 'utf8')
    .split('\n').filter((line) => !/^\s*#/.test(line)).join('\n')
  assert.match(
    workflow,
    /PICKUP_PG_TEST_URL: postgresql:\/\/[^\n]+\n\s+run: node --test db\/scripts\/__tests__\/pickup-amount\.pg\.test\.js/,
  )
})

if (!URL) {
  test('提货冻结出库金额的 DB 兜底（未设 PICKUP_PG_TEST_URL，跳过）', { skip: true }, () => {})
} else {
  runSuite()
}

function runSuite() {
  const client = new Client({ connectionString: URL })

  test.before(async () => {
    await client.connect()
    const { rows } = await client.query('SELECT current_database() AS db')
    if (FORBIDDEN_DB_NAMES.includes(rows[0].db)) {
      throw new Error(`拒绝在业务库上运行本套件：current_database()=${rows[0].db}`)
    }
  })
  test.after(async () => {
    await client.end()
  })

  /**
   * 在事务里 seed 门店 + 员工 + 一条家居销售明细，跑完回滚。
   * ⚠ 标价 unit_price=100 与实际单价 unit_real_price=88.50 故意不同：同值时把 trigger 的取值列
   *   误改成 unit_price 也全绿（#341 评审 round-2）。
   */
  async function withFixtures(fn) {
    await client.query('BEGIN')
    try {
      await client.query(`INSERT INTO org_nodes (id, name, type) VALUES ('${P}HQ', '${P}总部', '总部')`)
      await client.query(`INSERT INTO org_nodes (id, name, type, parent_id) VALUES ('${P}MK', '${P}市场', '市场', '${P}HQ')`)
      await client.query(`INSERT INTO org_nodes (id, name, type, parent_id) VALUES ('${P}ST', '${P}门店', '门店', '${P}MK')`)
      await client.query(`INSERT INTO stores (store_id, store_name, org_node_id) VALUES ('${P}ST', '${P}门店', '${P}ST')`)
      await client.query(`INSERT INTO staff_wechat_users (employee_id, name) VALUES ('${P}EMP', '${P}员工')`)
      await client.query(
        `INSERT INTO sale_orders (sale_order_id, market_name, store_id, sale_order_datetime,
                                  total_amount, payment_method, status, sale_order_type,
                                  performance_attribution_date)
         VALUES ('${P}SO', '${P}市场', '${P}ST', '2026-09-25 10:00:00+08', 442.5, '微信', '已支付', '销售单', '2026-09-25')`,
      )
      await client.query(
        `INSERT INTO sale_items (sale_item_id, sale_order_id, store_id, product_type, product_name,
                                 item_direction, quantity, unit_price, unit_real_price, sale_amount, received)
         VALUES ('${P}SI', '${P}SO', '${P}ST', '家居产品', '${P}家居', '购买', 5, 100, 88.5, 442.5, 442.5)`,
      )
      await fn()
    } finally {
      await client.query('ROLLBACK')
    }
  }

  async function insertPickup(quantity, unitPrice, amount) {
    await client.query('SAVEPOINT sp')
    try {
      await client.query(
        `INSERT INTO pickup_records (sale_item_id, pickup_quantity, store_id, confirmed_by, pickup_unit_price, pickup_amount)
         VALUES ('${P}SI', $1, '${P}ST', '${P}EMP', $2, $3)`,
        [quantity, unitPrice, amount],
      )
      await client.query('RELEASE SAVEPOINT sp')
      return null
    } catch (err) {
      await client.query('ROLLBACK TO SAVEPOINT sp')
      return err
    }
  }

  test('冻结金额 = ROUND(单价 × 数量, 2) 可写；写入端没带两列（旧式 INSERT / 显式双 NULL）由 trigger 按锁内单价补齐', async () => {
    await withFixtures(async () => {
      assert.equal(await insertPickup(2, '88.50', '177.00'), null)
      assert.equal(await insertPickup(4, '0.00', '0.00'), null, '0 元行冻结为 0 必须可写')
      assert.equal(await insertPickup(2, null, null), null)
      // 发版空档里旧版本的 INSERT：根本不带这两列
      await client.query(
        `INSERT INTO pickup_records (sale_item_id, pickup_quantity, store_id, confirmed_by)
         VALUES ('${P}SI', 3, '${P}ST', '${P}EMP')`,
      )
      const { rows } = await client.query(
        `SELECT pickup_quantity, pickup_unit_price::text, pickup_amount::text
           FROM pickup_records WHERE sale_item_id = '${P}SI' ORDER BY id`,
      )
      assert.deepEqual(rows.map((row) => [row.pickup_quantity, row.pickup_unit_price, row.pickup_amount]), [
        [2, '88.50', '177.00'],
        [4, '0.00', '0.00'],
        [2, '88.50', '177.00'],
        [3, '88.50', '265.50'],
      ])
    })
  })

  test('trigger 只补不改：写入端显式给了冻结值时原样保留（不被当前单价覆盖）', async () => {
    await withFixtures(async () => {
      // 模拟「提货时单价 80，之后订单改价到 88.50」——冻结值以写入端为准
      assert.equal(await insertPickup(1, '80.00', '80.00'), null)
      const { rows } = await client.query(
        `SELECT pickup_unit_price::text, pickup_amount::text FROM pickup_records WHERE sale_item_id = '${P}SI'`,
      )
      assert.deepEqual(rows, [{ pickup_unit_price: '80.00', pickup_amount: '80.00' }])
    })
  })

  test('金额算错、只写一列一律被 chk_pickup_amount_frozen 拒绝', async () => {
    await withFixtures(async () => {
      for (const [quantity, unitPrice, amount, label] of [
        [2, '88.50', '88.50', '金额写成单价'],
        [2, '88.50', '177.01', '差一分'],
        [2, '88.50', null, '只写单价'],
        [2, null, '177.00', '只写金额'],
      ]) {
        const err = await insertPickup(quantity, unitPrice, amount)
        assert.ok(err, `${label} 应被拒绝`)
        assert.equal(err.code, '23514', label)
        assert.equal(err.constraint, 'chk_pickup_amount_frozen', label)
      }
    })
  })

  test('GCK 明细只写批次价格快照：amount 按门店成本 → 市场 → 供应链 兜底，赠送记 0', async () => {
    await withFixtures(async () => {
      await client.query(
        `INSERT INTO inventory_skus (sku_id, product_code, product_name, source_type)
         VALUES ('${P}SKU', '${P}SKU', '${P}库存品', '市场自采')`,
      )
      await client.query(
        `INSERT INTO inventory_docs (id, doc_type, status, source_org_node_id, doc_date, created_by)
         VALUES ('${P}GCK', '院顾客产品出库', '已完成', '${P}ST', CURRENT_DATE, '${P}EMP')`,
      )
      const cases = [
        { label: '门店成本优先', gift: false, store: '30.00', market: '19.00', supply: '12.00', expected: '60.00' },
        { label: '无门店成本取市场结算价', gift: false, store: null, market: '19.00', supply: '12.00', expected: '38.00' },
        { label: '都没有取供应链成本', gift: false, store: null, market: null, supply: '12.00', expected: '24.00' },
        { label: '赠送批次记 0', gift: true, store: '30.00', market: null, supply: null, expected: '0.00' },
        { label: '无任何价格快照 → NULL（不编造成本）', gift: false, store: null, market: null, supply: null, expected: null },
      ]
      for (const item of cases) {
        const { rows } = await client.query(
          `INSERT INTO inventory_doc_items (
             doc_id, sku_id, sale_item_id, sku_name, batch_no, is_gift, quantity,
             supply_chain_unit_cost, market_actual_unit_price, store_actual_unit_price
           ) VALUES ('${P}GCK', '${P}SKU', '${P}SI', '${P}库存品', 'B1', $1, 2, $2, $3, $4)
           RETURNING actual_unit_price::text, amount::text`,
          [item.gift, item.supply, item.market, item.store],
        )
        assert.equal(rows[0].actual_unit_price, null, `${item.label}：actual_unit_price 不应被写入`)
        assert.equal(rows[0].amount, item.expected, item.label)
      }
    })
  })
}
