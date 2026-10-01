/**
 * 盘点单实盘数允许 0 的 DB 兜底回归（issue #351）
 *
 * 背景：`inventory_doc_items` 没有 doc_type 列，CHECK 分不出盘点与非盘点。迁移把
 * `chk_inventory_doc_items_qty` 放宽为 `quantity >= 0`，「非盘点类型仍须 > 0」交给按 doc_id
 * 回查单头的 trigger。本套件在真 PG 上证明三件事：
 *   1. 两种盘点单能插入实盘 0 的明细；
 *   2. 非盘点单的 0 数量无论从哪条路进来（INSERT / UPDATE quantity / UPDATE doc_id 挪行）
 *      都被拒，且报错仍是 check_violation + 原约束名；单头改 doc_type 由既有 lifecycle 守卫挡；
 *   3. 负数一律被 CHECK 拒。
 *
 * 运行（需要一个已 apply 全部 migration 的库；绝不要指向业务库）：
 *
 *   docker run -d --name pg-verify-351 -e POSTGRES_PASSWORD=test -e POSTGRES_DB=verify351 \
 *     -p 54403:5432 postgres:16
 *   DATABASE_URL="postgresql://postgres:test@localhost:54403/verify351" \
 *     bash db/scripts/bootstrap-from-zero.sh
 *   INVENTORY_PG_TEST_URL="postgresql://postgres:test@localhost:54403/verify351" \
 *     node --test db/scripts/__tests__/inventory-doc-item-quantity.pg.test.js
 *   docker rm -f pg-verify-351
 *
 * 未设变量时整个套件 skip。每条用例在自己的事务里 seed、断言、ROLLBACK，不留任何数据，
 * 可与其它 pg 套件同库并行（夹具 id 带 T351PG_ 前缀，事务内可见性互不干扰）。
 */

const test = require('node:test')
const assert = require('node:assert/strict')
const { Client } = require('pg')

const URL = process.env.INVENTORY_PG_TEST_URL

/** 业务库名单：连上之后问库名，命中即拒（IP 黑名单是 fail-open 的）。 */
const FORBIDDEN_DB_NAMES = ['fengyu_wxapp', 'fengyu_e2e', 'fengyu']

const P = 'T351PG_'

if (!URL) {
  test('盘点单实盘数允许 0 的 DB 兜底（未设 INVENTORY_PG_TEST_URL，跳过）', { skip: true }, () => {})
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

  /** 在事务里 seed 一个市场主体 + SKU + 给定类型的单头，跑完回滚。 */
  async function withDocs(docTypes, fn) {
    await client.query('BEGIN')
    try {
      await client.query(`INSERT INTO staff_wechat_users (employee_id) VALUES ('${P}EMP')`)
      await client.query(`INSERT INTO org_nodes (id, name, type) VALUES ('${P}HQ', '${P}总部', '总部')`)
      await client.query(
        `INSERT INTO org_nodes (id, name, type, parent_id) VALUES ('${P}MKT', '${P}市场', '市场', '${P}HQ')`,
      )
      await client.query(
        `INSERT INTO inventory_skus (sku_id, product_code, product_name, source_type)
         VALUES ('${P}SKU', '${P}SKU', '${P}商品', '市场自采')`,
      )
      const ids = {}
      for (const [key, docType] of Object.entries(docTypes)) {
        ids[key] = `${P}${key}`
        await client.query(
          `INSERT INTO inventory_docs (id, doc_type, status, source_org_node_id, target_org_node_id, doc_date, created_by)
           VALUES ($1, $2, '草稿', '${P}MKT', '${P}MKT', CURRENT_DATE, '${P}EMP')`,
          [ids[key], docType],
        )
      }
      await fn(ids)
    } finally {
      await client.query('ROLLBACK')
    }
  }

  function insertItem(docId, quantity) {
    return client.query(
      `INSERT INTO inventory_doc_items (doc_id, sku_id, sku_name, quantity)
       VALUES ($1, '${P}SKU', '${P}商品', $2) RETURNING id`,
      [docId, quantity],
    )
  }

  /** 断言语句被 chk_inventory_doc_items_qty（CHECK 或 trigger 沿用的同名）拒绝，且不毒化外层事务。 */
  async function assertQtyViolation(run, label) {
    await client.query('SAVEPOINT sp')
    try {
      await assert.rejects(run, (err) => {
        assert.equal(err.code, '23514', `${label}：应为 check_violation，实际 ${err.code} ${err.message}`)
        assert.equal(err.constraint, 'chk_inventory_doc_items_qty', `${label}：约束名应沿用原 CHECK`)
        return true
      }, label)
    } finally {
      await client.query('ROLLBACK TO SAVEPOINT sp')
    }
  }

  for (const docType of ['市场库存盘点', '分院库存盘点']) {
    test(`${docType}：实盘 0 的明细可以落库`, async () => {
      // 分院盘点在真实业务里挂门店主体；这里只验数量规则，主体用市场即可（trigger 只看 doc_type）。
      await withDocs({ PD: docType }, async (ids) => {
        const { rows } = await insertItem(ids.PD, 0)
        const { rows: stored } = await client.query(
          'SELECT quantity::text AS quantity FROM inventory_doc_items WHERE id = $1', [rows[0].id],
        )
        assert.equal(stored[0].quantity, '0.00')
      })
    })
  }

  test('盘点单的负数仍被 CHECK 拒绝', async () => {
    await withDocs({ PD: '市场库存盘点' }, async (ids) => {
      await assertQtyViolation(() => insertItem(ids.PD, -1), '盘点单插入 -1')
    })
  })

  test("numeric 的 'NaN'（PG 里大于一切有限数）盘点与非盘点都拒", async () => {
    await withDocs({ PD: '市场库存盘点', BS: '市场产品报损' }, async (ids) => {
      await assertQtyViolation(() => insertItem(ids.PD, 'NaN'), '盘点单插入 NaN')
      await assertQtyViolation(() => insertItem(ids.BS, 'NaN'), '报损单插入 NaN')
    })
  })

  test('非盘点单插入数量 0 被拒，正数照常', async () => {
    await withDocs({ BS: '市场产品报损', DB: '市场间调货出库' }, async (ids) => {
      await assertQtyViolation(() => insertItem(ids.BS, 0), '报损单插入 0')
      await assertQtyViolation(() => insertItem(ids.DB, 0), '调货出库插入 0')
      await assertQtyViolation(() => insertItem(ids.BS, -2), '报损单插入 -2')
      await insertItem(ids.BS, 1)
    })
  })

  test('非盘点单把已有明细 UPDATE 成 0 被拒', async () => {
    await withDocs({ BS: '市场产品报损' }, async (ids) => {
      const { rows } = await insertItem(ids.BS, 3)
      await assertQtyViolation(
        () => client.query('UPDATE inventory_doc_items SET quantity = 0 WHERE id = $1', [rows[0].id]),
        '报损明细改成 0',
      )
    })
  })

  test('把盘点单的 0 数量明细挪到非盘点单（UPDATE doc_id）被拒', async () => {
    await withDocs({ PD: '分院库存盘点', BS: '市场产品报损' }, async (ids) => {
      const { rows } = await insertItem(ids.PD, 0)
      await assertQtyViolation(
        () => client.query('UPDATE inventory_doc_items SET doc_id = $1 WHERE id = $2', [ids.BS, rows[0].id]),
        '0 数量明细挪到报损单',
      )
    })
  })

  test('单头不存在 / 数量为 NULL 时让位给 FK / NOT NULL 报错，不抢报成 check_violation', async () => {
    await withDocs({ BS: '市场产品报损' }, async (ids) => {
      for (const [label, docId, quantity, code] of [
        ['doc_id 不存在', `${P}NO_SUCH_DOC`, 0, '23503'],
        ['非盘点 quantity NULL', ids.BS, null, '23502'],
      ]) {
        await client.query('SAVEPOINT sp')
        try {
          await assert.rejects(() => insertItem(docId, quantity), (err) => {
            assert.equal(err.code, code, `${label}：应为 ${code}，实际 ${err.code} ${err.message}`)
            return true
          })
        } finally {
          await client.query('ROLLBACK TO SAVEPOINT sp')
        }
      }
    })
  })

  /**
   * 反向口子：盘点单带着 0 数量明细改成非盘点类型，行级 trigger 看不到（没动明细行）。
   * 这个口子由 `inventory_validate_doc_lifecycle` 的「创建后禁止修改单据类型」堵住 ——
   * 本迁移因此不另加单头 trigger。这里钉住那条前提：它哪天被放开，这条必须红。
   */
  test('单头 doc_type 创建后不可改（0 数量明细不会借改类型混进非盘点单）', async () => {
    await withDocs({ PD: '市场库存盘点' }, async (ids) => {
      await insertItem(ids.PD, 0)
      await client.query('SAVEPOINT sp')
      try {
        await assert.rejects(
          () => client.query(`UPDATE inventory_docs SET doc_type = '市场产品报损' WHERE id = $1`, [ids.PD]),
          /禁止修改单据类型/,
        )
      } finally {
        await client.query('ROLLBACK TO SAVEPOINT sp')
      }
    })
  })
}
