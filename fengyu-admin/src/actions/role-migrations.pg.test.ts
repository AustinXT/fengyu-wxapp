import { it, expect, vi } from 'vitest'
import { Client } from 'pg'
import { drizzle } from 'drizzle-orm/node-postgres'
import { PgDialect } from 'drizzle-orm/pg-core'
import { randomUUID } from 'node:crypto'
const state = vi.hoisted(() => ({ db: null as any, session: null as any }))
vi.mock('@/db', () => ({ db: { execute: (...args: any[]) => state.db.execute(...args), transaction: (...args: any[]) => state.db.transaction(...args) } }))
vi.mock('@/lib/auth', () => ({ getSession: async () => state.session }))
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }))
import { reviewEmployeeRoleMigration } from './role-migrations'
const url = process.env.ROLE_MIGRATION_PG_TEST_URL
it.skipIf(!url)('真实action双连接交错：advisory等待、旧CAS冲突、目标去重及审计失败回滚', async () => {
  const parsed = new URL(url!)
  expect(['127.0.0.1', 'localhost']).toContain(parsed.hostname)
  expect(['/issue256schema', '/role_migrations_test']).toContain(parsed.pathname)
  const schema = 'role304_' + randomUUID().replaceAll('-', '')
  const owner = new Client({ connectionString: url }); await owner.connect()
  let release!: () => void, entered!: () => void
  const gate = new Promise<void>(r => { release = r }), paused = new Promise<void>(r => { entered = r })
  const pids: number[] = []; let first = true
  let tasks: Promise<any>[] = []
  try {
    await owner.query(`CREATE SCHEMA ${schema}`)
    await owner.query(`SET search_path=${schema},public`)
    await owner.query(`
      CREATE TABLE org_nodes(id text PRIMARY KEY,name text,type text);
      CREATE TABLE stores(store_id text PRIMARY KEY,org_node_id text REFERENCES org_nodes(id),store_name text,is_closed boolean DEFAULT false);
      CREATE TABLE staff_wechat_users(employee_id text PRIMARY KEY,name text,store_id text REFERENCES stores(store_id),org_node_id text REFERENCES org_nodes(id),is_resigned boolean DEFAULT false);
      CREATE TABLE permission_role_definitions(role_key text PRIMARY KEY,name text,is_super_admin boolean,allowed_scope_types text[]);
      CREATE TABLE permission_roles(id bigserial PRIMARY KEY,employee_id text REFERENCES staff_wechat_users(employee_id),role text REFERENCES permission_role_definitions(role_key),scope_id text REFERENCES org_nodes(id),updated_at timestamptz DEFAULT now(),updated_by text, UNIQUE(employee_id,role,scope_id));
      CREATE TABLE operation_logs(id bigserial PRIMARY KEY,operator_employee_id text REFERENCES staff_wechat_users(employee_id),operator_name text,operator_role text,org_node_id text REFERENCES org_nodes(id),org_node_name text,action text NOT NULL,target_type text NOT NULL,target_id text NOT NULL,detail jsonb,source text,created_at timestamptz DEFAULT now());
      INSERT INTO org_nodes VALUES('root','总部','总部'),('old','旧店','门店'),('new','新店','门店');
      INSERT INTO stores(store_id,org_node_id,store_name) VALUES('O','old','旧店'),('S','new','新店');
      INSERT INTO staff_wechat_users(employee_id,store_id,org_node_id) VALUES('E','S','new'),('operator',NULL,'root');
      INSERT INTO permission_role_definitions VALUES('manager','店长',false,ARRAY['门店']);
      INSERT INTO permission_roles(employee_id,role,scope_id) VALUES('E','manager','old');
      INSERT INTO operation_logs(action,target_type,target_id,detail) VALUES('permission.scopeSync.skipped','employee','E','{"reason":"manual_review_required","oldStoreId":"O","newStoreId":"S","roles":["manager"]}');
    `)
    const dialect = new PgDialect()
    state.session = { employeeId: 'operator', name: '合成测试', roles: [{ role: 'admin', isSuperAdmin: true, scopeId: 'root', actions: ['permission:assign', 'permission:revoke'], scopeStoreIds: [], scopeOrgNodeIds: ['root'] }], permissions: { actions: ['permission:assign', 'permission:revoke'], scopeStoreIds: [], scopeOrgNodeIds: ['root'] } }
    state.db = { transaction: async (fn: any) => {
      const client = new Client({ connectionString: url }); await client.connect()
      const pid = (await client.query('SELECT pg_backend_pid() AS pid')).rows[0].pid; pids.push(pid)
      const orm = drizzle(client)
      try {
        await client.query('BEGIN'); await client.query(`SET LOCAL search_path=${schema},public`)
        const tx = { select: orm.select.bind(orm), insert: orm.insert.bind(orm), execute: async (query: any) => {
          const q = dialect.sqlToQuery(query); const result = await client.query(q.sql, q.params)
          if (first && q.sql.includes('UPDATE permission_roles') && result.rowCount === 1) { first = false; entered(); await gate }
          return result.rows
        } }
        const result = await fn(tx); await client.query('COMMIT'); return result
      } catch (error) { await client.query('ROLLBACK'); throw error }
      finally { await client.end() }
    } }
    const input = { employeeId: 'E', targetScopeId: 'new', decision: 'migrate' as const, bindings: [{ id: 1, role: 'manager', scopeId: 'old' }] }
    const a = reviewEmployeeRoleMigration(input); tasks.push(a); await Promise.race([paused, a.then(() => { throw new Error('action未进入预期交错点') })])
    // 立即注册拒绝处理，避免预期CONFLICT被runner判为unhandled rejection。
    const b = reviewEmployeeRoleMigration(input).then(value => ({ value }), error => ({ error })); tasks.push(b)
    let waiting = false
    for (let tries=0; tries<100 && !waiting; tries++) {
      const row = pids[1] && (await owner.query('SELECT wait_event FROM pg_stat_activity WHERE pid=$1', [pids[1]])).rows[0]
      waiting = row?.wait_event === 'advisory'
      if (!waiting) await new Promise(r => setTimeout(r, 20))
    }
    expect(waiting, '第二个真实action应等在org advisory锁').toBe(true)
    release(); await a
    const loser = await b; expect(('error' in loser ? loser.error : null)?.message).toMatch(/^CONFLICT:/)
    expect((await owner.query('SELECT scope_id FROM permission_roles')).rows).toEqual([{ scope_id: 'new' }])
    expect((await owner.query("SELECT count(*)::int AS cnt FROM operation_logs WHERE action='permission.scopeMigrate'")).rows[0].cnt).toBe(1)
    expect((await owner.query("SELECT count(*)::int AS cnt FROM operation_logs WHERE action='permission.scopeReview.completed'")).rows[0].cnt).toBe(1)
    // 目标已有同角色：真实唯一约束下只删旧，保留目标。
    const old = (await owner.query("INSERT INTO permission_roles(employee_id,role,scope_id) VALUES('E','manager','old') RETURNING id::int")).rows[0].id
    await reviewEmployeeRoleMigration({ ...input, bindings: [{ ...input.bindings[0], id: old }] })
    expect((await owner.query('SELECT scope_id FROM permission_roles')).rows).toEqual([{ scope_id: 'new' }])
    // 审计INSERT真正失败，业务DELETE必须回滚，不是mock返回失败。
    const old2 = (await owner.query("INSERT INTO permission_roles(employee_id,role,scope_id) VALUES('E','manager','old') RETURNING id::int")).rows[0].id
    await owner.query(`CREATE FUNCTION reject_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'synthetic audit failure'; END $$;
      CREATE TRIGGER reject_audit BEFORE INSERT ON operation_logs FOR EACH ROW EXECUTE FUNCTION reject_audit();`)
    await expect(reviewEmployeeRoleMigration({ ...input, bindings: [{ ...input.bindings[0], id: old2 }] })).rejects.toMatchObject({ cause: expect.objectContaining({ message: 'synthetic audit failure' }) })
    expect((await owner.query('SELECT scope_id FROM permission_roles WHERE id=$1', [old2])).rows[0].scope_id).toBe('old')
  } finally { release(); await Promise.allSettled(tasks); await owner.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`); await owner.end() }
}, 15000)
