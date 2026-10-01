/**
 * sync-workfine 门店 UPSERT 的字面量守护（#401，闸门 2 codex round-6 P2）。
 *
 * 语义（首次关店记当天 / 重复同步保留原日期 / 重新开业清空）由
 * `sync-workfine-store-upsert.pg.test.js` 在真实 PG 上验证，但那个套件需要本地 PG、默认 skip。
 * 本文件在任何机器上都跑：把 SQL 整段钉死，改任何一处（如 COALESCE 改成 EXCLUDED.closed_at，
 * 每次同步都把闭店日推到当天、篡改历史时点门店数）都会变红，逼改动者去跑 .pg.test 复验语义。
 */
const test = require('node:test')
const assert = require('node:assert/strict')
const { STORE_UPSERT_SQL } = require('../sync-workfine')

const normalize = (text) => text.replace(/\s+/g, ' ').trim()

test('门店 UPSERT 整段等值（closed_at 与 is_closed 双写、不碰 org_nodes.is_active）', () => {
  assert.equal(
    normalize(STORE_UPSERT_SQL),
    'INSERT INTO stores (store_id, store_name, org_node_id, opening_date, bed_count, is_closed, closed_at)' +
      " VALUES ($1, $2, $3, $4, $5, $6, CASE WHEN $6 THEN (now() AT TIME ZONE 'Asia/Shanghai')::date END)" +
      ' ON CONFLICT (store_id) DO UPDATE SET' +
      ' store_name = EXCLUDED.store_name,' +
      ' org_node_id = EXCLUDED.org_node_id,' +
      ' opening_date = EXCLUDED.opening_date,' +
      ' bed_count = EXCLUDED.bed_count,' +
      ' is_closed = EXCLUDED.is_closed,' +
      ' closed_at = CASE WHEN EXCLUDED.is_closed THEN COALESCE(stores.closed_at, EXCLUDED.closed_at) END,' +
      ' updated_at = now()',
  )
})

test('脚本主流程确实用这条常量写门店（不是另写一份）', () => {
  const src = require('node:fs').readFileSync(require.resolve('../sync-workfine'), 'utf8')
  assert.equal(src.split('INSERT INTO stores (').length - 1, 1, 'INSERT INTO stores 只能出现在 STORE_UPSERT_SQL 一处')
  assert.match(src, /await client\.query\(STORE_UPSERT_SQL, \[storeId, storeName, storeOrgNodeId, toDateStr\(row\.opening_date\), row\.bed_count \|\| null, isClosed\]\)/)
})
