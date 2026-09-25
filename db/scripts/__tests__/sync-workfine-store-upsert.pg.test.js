/**
 * sync-workfine 门店 UPSERT 的真实 PG 语义回归（#401，闸门 2 codex round-6 P2）。
 *
 * 只用会话级 TEMP 表（`pg_temp.stores` 在 search_path 上优先于 public.stores），不依赖 migration，
 * 不写任何持久数据。运行：
 *
 *   docker run -d --name pg-upsert -e POSTGRES_PASSWORD=test -p 54398:5432 postgres:16
 *   STORE_UPSERT_PG_TEST_URL="postgresql://postgres:test@localhost:54398/postgres" \
 *     node --test db/scripts/__tests__/sync-workfine-store-upsert.pg.test.js
 *
 * 没设 STORE_UPSERT_PG_TEST_URL 时 skip；字面量守护见 sync-workfine-store-upsert.test.js（恒跑）。
 * 用独立环境变量而不是 DATABASE_URL，且连上后拒绝业务库名（同 attribution-trigger.pg.test.js）。
 */
const test = require('node:test')
const assert = require('node:assert/strict')
const { Client } = require('pg')
const { STORE_UPSERT_SQL } = require('../sync-workfine')

const URL = process.env.STORE_UPSERT_PG_TEST_URL
const FORBIDDEN_DB_NAMES = ['fengyu_wxapp', 'fengyu_e2e']

if (!URL) {
  test('门店 UPSERT 真实 PG 语义（未设 STORE_UPSERT_PG_TEST_URL，跳过）', { skip: true }, () => {})
} else {
  test('门店 UPSERT：首次关店记当天 / 重复同步保留原日期 / 重新开业清空 / 在营保持 NULL', async () => {
    const db = new Client({ connectionString: URL })
    await db.connect()
    try {
      const { rows: [{ name }] } = await db.query('SELECT current_database() AS name')
      assert.ok(!FORBIDDEN_DB_NAMES.includes(name), `拒绝在业务库 ${name} 上跑`)

      await db.query(`
        CREATE TEMP TABLE stores (
          store_id text PRIMARY KEY, store_name text, org_node_id text, opening_date date, bed_count integer,
          is_closed boolean NOT NULL DEFAULT false, closed_at date, updated_at timestamptz NOT NULL DEFAULT now()
        )`)
      const { rows: [{ today }] } = await db.query(`SELECT to_char((now() AT TIME ZONE 'Asia/Shanghai')::date, 'YYYY-MM-DD') AS today`)
      const upsert = (id, isClosed) => db.query(STORE_UPSERT_SQL, [id, `店${id}`, `node-${id}`, '2025-01-01', 8, isClosed])
      const closedAt = async (id) => {
        const { rows: [r] } = await db.query(`SELECT is_closed, to_char(closed_at, 'YYYY-MM-DD') AS closed_at FROM stores WHERE store_id = $1`, [id])
        return r
      }

      // 首次插入：在营 → NULL；已关 → 当天
      await upsert('A', false)
      assert.deepEqual(await closedAt('A'), { is_closed: false, closed_at: null })
      await upsert('B', true)
      assert.deepEqual(await closedAt('B'), { is_closed: true, closed_at: today })

      // 在营 → 关店：记当天
      await upsert('A', true)
      assert.deepEqual(await closedAt('A'), { is_closed: true, closed_at: today })

      // 已关店且有真实闭店日：重复同步保留原日期（不能被推到当天）
      await db.query(`UPDATE stores SET closed_at = '2026-01-05' WHERE store_id = 'A'`)
      await upsert('A', true)
      assert.deepEqual(await closedAt('A'), { is_closed: true, closed_at: '2026-01-05' })

      // 重新开业：清空闭店日
      await upsert('A', false)
      assert.deepEqual(await closedAt('A'), { is_closed: false, closed_at: null })

      // 在营重复同步：保持 NULL
      await upsert('A', false)
      assert.deepEqual(await closedAt('A'), { is_closed: false, closed_at: null })
    } finally {
      await db.end()
    }
  })
}
