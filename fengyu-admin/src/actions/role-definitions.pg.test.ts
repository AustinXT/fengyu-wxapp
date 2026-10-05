import { expect, it, vi } from 'vitest'
import { Client } from 'pg'
import { PgDialect } from 'drizzle-orm/pg-core'
import { drizzle } from 'drizzle-orm/node-postgres'
import { orgNodeTypeEnum } from '@db/enums'

const state = vi.hoisted(() => ({ db: null as any }))
vi.mock('@/db', () => ({ db: {
  select: (...args: any[]) => state.db.select(...args),
  execute: (...args: any[]) => state.db.execute(...args),
  transaction: (...args: any[]) => state.db.transaction(...args),
} }))
vi.mock('@/lib/with-permission', () => ({
  withPermission: (_permission: string, handler: Function) => (...args: unknown[]) => handler({ employeeId: 'operator' }, ...args),
  withAnyPermission: (_permissions: string[], handler: Function) => handler,
}))
vi.mock('@/lib/permissions', () => ({
  requireAdmin: vi.fn(), invalidatePermissionMatrixCache: vi.fn(),
  KNOWN_PERMISSION_ACTIONS: ['dashboard:view'],
}))
vi.mock('@/lib/operation-log', () => ({ logOperation: vi.fn(), logUpdate: vi.fn() }))
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }))

import { updateRoleDefinition, type RoleDefinitionInput } from './role-definitions'

const url = process.env.ROLE_DEFINITION_PG_TEST_URL

it.skipIf(!url)('真实 PG 枚举：角色层级校验支持多值、单值，并拒绝越层级和失效节点', async () => {
  const parsed = new URL(url!)
  expect(['127.0.0.1', 'localhost']).toContain(parsed.hostname)
  expect(parsed.pathname).toBe('/issue527_permission_matrix_test')
  const client = new Client({ connectionString: url })
  await client.connect()
  try {
    await client.query('BEGIN')
    // 仅临时对象；必须用真实 enum，text 替身会掩盖生产的 42883 错误。
    const enumValues = orgNodeTypeEnum.enumValues.map(value => `'${value.replaceAll("'", "''")}'`).join(', ')
    await client.query(`
      CREATE TYPE pg_temp.role_scope_test AS ENUM (${enumValues});
      CREATE TEMP TABLE org_nodes(id text PRIMARY KEY, type pg_temp.role_scope_test);
      CREATE TEMP TABLE permission_roles(role text, scope_id text);
      CREATE TEMP TABLE permission_role_definitions(
        role_key varchar(64) PRIMARY KEY, name varchar(30) NOT NULL, description varchar(200),
        actions text[] NOT NULL, allowed_scope_types text[] NOT NULL,
        can_access_admin boolean NOT NULL, is_super_admin boolean NOT NULL, is_store_manager boolean NOT NULL,
        created_by text, updated_by text, created_at timestamptz DEFAULT now(), updated_at timestamptz NOT NULL
      );
      CREATE TEMP TABLE system_configs(key text PRIMARY KEY, value text, updated_at timestamptz);
      INSERT INTO permission_role_definitions(role_key, name, actions, allowed_scope_types,
        can_access_admin, is_super_admin, is_store_manager, updated_at)
        VALUES ('manager', '店长', ARRAY['dashboard:view'], ARRAY['总部','市场','门店'], true, false, true,
          '2026-10-02T08:05:08.225123Z');
      INSERT INTO org_nodes VALUES ('root', '总部'), ('market', '市场'), ('store', '门店'), ('department', '部门');
      INSERT INTO permission_roles VALUES ('manager', 'store');
    `)
    const dialect = new PgDialect()
    let scopeQueries = 0
    const execute = async (query: any) => {
      const compiled = dialect.sqlToQuery(query)
      if (compiled.sql.includes('FROM permission_roles pr')) scopeQueries++
      return (await client.query(compiled.sql, compiled.params)).rows
    }
    const orm = drizzle(client)
    let lateConflict = false
    state.db = {
      select: orm.select.bind(orm),
      execute,
      transaction: async (handler: Function) => {
        await client.query('SAVEPOINT role_update')
        try {
          // 模拟早拒通过后出现冲突：事务内权威复核仍必须拒绝并回滚真实 UPDATE。
          if (lateConflict) await client.query("UPDATE permission_roles SET scope_id = 'department'")
          const result = await handler({
            execute, update: orm.update.bind(orm), select: orm.select.bind(orm),
          })
          await client.query('RELEASE SAVEPOINT role_update')
          return result
        } catch (error) {
          await client.query('ROLLBACK TO SAVEPOINT role_update')
          await client.query('RELEASE SAVEPOINT role_update')
          throw error
        }
      },
    }
    const input: RoleDefinitionInput = {
      name: '店长', actions: ['dashboard:view'], allowedScopeTypes: ['总部', '市场', '门店'],
      canAccessAdmin: true, isSuperAdmin: false, isStoreManager: true,
    }
    for (const allowedScopeTypes of [['总部', '市场', '门店'], ['门店']] as Array<Array<'总部' | '市场' | '门店'>>) {
      scopeQueries = 0
      await expect(updateRoleDefinition('manager', { ...input, allowedScopeTypes })).resolves.toMatchObject({ success: true })
      const saved = (await client.query("SELECT allowed_scope_types, updated_by FROM permission_role_definitions WHERE role_key = 'manager'")).rows[0]
      expect(saved).toEqual({ allowed_scope_types: allowedScopeTypes, updated_by: 'operator' })
      const mirror = (await client.query("SELECT value FROM system_configs WHERE key = 'permission_matrix'")).rows[0]
      expect(JSON.parse(mirror.value)).toEqual({ manager: ['dashboard:view'] })
      expect(scopeQueries).toBe(2)
    }
    // 旧毫秒版本仍触发 CAS 冲突；同轮早拒合法时不能覆盖已保存角色。
    await expect(updateRoleDefinition('manager', {
      ...input, expectedUpdatedAt: '2026-10-02T08:05:08.225Z',
    })).resolves.toMatchObject({ success: false, message: '角色已被其他人修改，请刷新重试' })
    const savedBeforeConflict = (await client.query('SELECT * FROM permission_role_definitions')).rows
    lateConflict = true
    scopeQueries = 0
    await expect(updateRoleDefinition('manager', { ...input, name: '不应保存的名称' })).rejects.toThrow('INVALID_STATE: 存在与新可绑定层级冲突')
    expect(scopeQueries).toBe(2)
    expect((await client.query('SELECT * FROM permission_role_definitions')).rows).toEqual(savedBeforeConflict)
    lateConflict = false
    await expect(updateRoleDefinition('manager', { ...input, allowedScopeTypes: ['总部'] })).rejects.toThrow('INVALID_STATE: 存在与新可绑定层级冲突')
    for (const scopeId of ['department', 'missing']) {
      await client.query('UPDATE permission_roles SET scope_id = $1', [scopeId])
      await expect(updateRoleDefinition('manager', input)).rejects.toThrow('INVALID_STATE: 存在与新可绑定层级冲突')
    }
  } finally {
    await client.query('ROLLBACK')
    await client.end()
  }
})
