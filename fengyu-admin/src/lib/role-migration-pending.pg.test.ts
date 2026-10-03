import { it, expect, vi } from 'vitest'
import { Client } from 'pg'
import { PgDialect } from 'drizzle-orm/pg-core'
import { logOperation } from './operation-log'
import type { AuthSession } from './types'
import { pendingRoleMigrationsSql } from './role-migration-pending'
import { auditRoleMigrations } from '../cron/steps/audit-role-migrations'
vi.mock('../cron/lib/notify', () => ({ notifyOps: vi.fn() }))
const url = process.env.ROLE_MIGRATION_PG_TEST_URL
it.skipIf(!url)('真实PG：明确调店才生成待办，多次调店/保留兼任/已迁移闭环', async () => {
  const parsed = new URL(url!)
  expect(parsed.hostname).toBe('127.0.0.1'); expect(parsed.port).toBe('54416'); expect(parsed.pathname).toBe('/issue256schema')
  const db = new Client({ connectionString: url }); await db.connect()
  try {
    await db.query('BEGIN')
    await db.query(`
      CREATE TEMP TABLE operation_logs(id bigint, target_id text, action text, detail jsonb, created_at timestamptz, target_type text, source text);
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
    const executorPg = { execute: async (query: any) => {
      const q = new PgDialect().sqlToQuery(query); return (await db.query(q.sql, q.params)).rows
    } }
    await db.query("SET LOCAL DateStyle = 'SQL, DMY'")
    expect(await auditRoleMigrations(executorPg as any)).toEqual({ overdueBindings: 2 })
    // now() 在事务内固定，恰好3天不属于“超过3天”。
    await db.query("UPDATE operation_logs SET created_at=now()-interval '3 days' WHERE id=10")
    expect(await auditRoleMigrations(executorPg as any)).toEqual({ overdueBindings: 1 })
    await db.query("UPDATE operation_logs SET created_at=now()-interval '5 days' WHERE id=10")
    // 用真实 logOperation/sanitizeDetail 产物入库，再验证 JSONB 闭环，不手造完成日志。
    const executor = { insert: () => ({ values: async (values: any) => {
      await db.query('INSERT INTO operation_logs VALUES($1,$2,$3,$4,now())', [12, values.targetId, values.action, JSON.stringify(values.detail)])
    } }) }
    await logOperation({ employeeId: 'operator', name: '合成测试', roles: [] } as unknown as AuthSession,
      'permission.scopeReview.completed', 'permission_role', 'E', { eventId: '10', bindingIds: [1], decision: 'retain' }, executor as any)
    expect((await read()).rows.map(r => +r.binding_id)).toEqual([2])
    const cas = await db.query("UPDATE permission_roles SET scope_id=$1 WHERE id=$2 AND employee_id=$3 AND role=$4 AND scope_id=$5 RETURNING id", ['nodeC', 2, 'E', 'staff', 'nodeB'])
    expect(cas.rowCount).toBe(1)
    expect((await read()).rows).toEqual([])
    expect((await db.query("UPDATE permission_roles SET scope_id=$1 WHERE id=$2 AND employee_id=$3 AND role=$4 AND scope_id=$5 RETURNING id", ['nodeC', 2, 'E', 'staff', 'nodeB'])).rowCount).toBe(0)
    await db.query('ROLLBACK')
  } finally { await db.query('ROLLBACK').catch(() => {}); await db.end() }
})
