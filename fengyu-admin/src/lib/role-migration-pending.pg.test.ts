import { it, expect } from 'vitest'
import { Client } from 'pg'
import { PgDialect } from 'drizzle-orm/pg-core'
import { pendingRoleMigrationsSql } from './role-migration-pending'
const url = process.env.ROLE_MIGRATION_PG_TEST_URL
it.skipIf(!url)('真实PG：明确调店才生成待办，多次调店/保留兼任/已迁移闭环', async () => {
  const parsed = new URL(url!)
  expect(parsed.hostname).toBe('127.0.0.1'); expect(parsed.port).toBe('54416'); expect(parsed.pathname).toBe('/issue256schema')
  const db = new Client({ connectionString: url }); await db.connect()
  try {
    await db.query('BEGIN')
    await db.query(`
      CREATE TEMP TABLE operation_logs(id bigint, target_id text, action text, detail jsonb, created_at timestamptz);
      CREATE TEMP TABLE staff_wechat_users(employee_id text, name text, store_id text, is_resigned boolean);
      CREATE TEMP TABLE stores(store_id text, org_node_id text);
      CREATE TEMP TABLE permission_roles(id bigint, employee_id text, role text, scope_id text);
      INSERT INTO stores VALUES('A','nodeA'),('B','nodeB'),('C','nodeC');
      INSERT INTO staff_wechat_users VALUES('E','合成员工','C',false),('LEGAL','合法兼任','C',false);
      INSERT INTO permission_roles VALUES(1,'E','manager','nodeA'),(2,'E','staff','nodeB'),(3,'LEGAL','manager','nodeA');
      INSERT INTO operation_logs VALUES
        (10,'E','permission.scopeSync.skipped','{"reason":"manual_review_required","oldStoreId":"A","newStoreId":"B","roles":["manager"]}',now()-interval '5 days'),
        (11,'E','permission.scopeSync.skipped','{"reason":"manual_review_required","oldStoreId":"B","newStoreId":"C","roles":["staff"]}',now()-interval '4 days');
    `)
    const read = () => { const q = new PgDialect().sqlToQuery(pendingRoleMigrationsSql()); return db.query(q.sql, q.params) }
    expect((await read()).rows.map(r => +r.binding_id)).toEqual([1, 2])
    await db.query(`INSERT INTO operation_logs VALUES(12,'E','permission.scopeReview.completed','{"eventId":"10","bindingIds":[1],"decision":"retain"}',now())`)
    expect((await read()).rows.map(r => +r.binding_id)).toEqual([2])
    const cas = await db.query("UPDATE permission_roles SET scope_id=$1 WHERE id=$2 AND employee_id=$3 AND role=$4 AND scope_id=$5 RETURNING id", ['nodeC', 2, 'E', 'staff', 'nodeB'])
    expect(cas.rowCount).toBe(1)
    expect((await read()).rows).toEqual([])
    expect((await db.query("UPDATE permission_roles SET scope_id=$1 WHERE id=$2 AND employee_id=$3 AND role=$4 AND scope_id=$5 RETURNING id", ['nodeC', 2, 'E', 'staff', 'nodeB'])).rowCount).toBe(0)
    await db.query('ROLLBACK')
  } finally { await db.query('ROLLBACK').catch(() => {}); await db.end() }
})
