import { describe, it, expect, vi } from 'vitest'

// scope-sql → permissions → @/db / @db/org，单测里 mock 掉（isAdminScope 本身是纯函数）
vi.mock('@/db', () => ({ db: { execute: vi.fn().mockResolvedValue([]) } }))
vi.mock('@db/org', () => ({
  orgNodes: { id: 'id', name: 'name', parentId: 'parent_id', type: 'type' },
  stores: { storeId: 'store_id', orgNodeId: 'org_node_id' },
}))

import { PgDialect } from 'drizzle-orm/pg-core'
import { scopeFilterSql, scopeStoreSkeletonSql, orgAnchorScopeSql } from './scope-sql'
import type { AuthSession, RoleType } from '@/lib/types'
import type { DataCenterScope } from './types'

const dialect = new PgDialect()
function render(fragment: ReturnType<typeof scopeFilterSql>) {
  const q = dialect.sqlToQuery(fragment)
  // SQL 关键字大小写不敏感断言：统一小写做 contains 检查；TRUE/FALSE 另用 toUpperCase
  return { sql: q.sql.toLowerCase(), raw: q.sql, params: q.params }
}

function makeSession(
  roles: Array<{ role: RoleType; scopeType: '总部' | '市场' | '门店' }>,
  scopeStoreIds: string[],
): AuthSession {
  return {
    employeeId: 'e1',
    name: 'n',
    phone: '13800000000',
    roles: roles.map((r) => ({ role: r.role, scopeId: 'sc', scopeType: r.scopeType })),
    permissions: { actions: [], scopeStoreIds },
  }
}

const ALL: DataCenterScope = { type: 'all' }

describe('scopeFilterSql — admin 空 scopeStoreIds 陷阱（★必守第一项）', () => {
  it('admin 角色 + 空 scopeStoreIds + scope=all → 仅保留启用门店过滤（绝不能是 FALSE）', () => {
    const session = makeSession([{ role: 'admin', scopeType: '总部' }], [])
    const { raw } = render(scopeFilterSql(session, ALL, 'so.store_id'))
    expect(raw.toUpperCase()).toContain('SO.STORE_ID IN')
    expect(raw.toUpperCase()).toContain('ACTIVE_NODE.IS_ACTIVE = TRUE')
    expect(raw.toUpperCase()).not.toContain('FALSE')
  })

  it('非 admin + 空 scopeStoreIds → FALSE（无可见门店）', () => {
    const session = makeSession([{ role: 'manager', scopeType: '门店' }], [])
    const { raw } = render(scopeFilterSql(session, ALL, 'so.store_id'))
    expect(raw.trim().toUpperCase()).toBe('FALSE')
  })
})

describe('scopeFilterSql — 账号权限范围', () => {
  it('非 admin + 有 scopeStoreIds → store_id IN (...) 且参数携带 id', () => {
    const session = makeSession([{ role: 'manager', scopeType: '市场' }], ['S1', 'S2'])
    const { sql, params } = render(scopeFilterSql(session, ALL, 'so.store_id'))
    expect(sql).toContain('so.store_id in')
    expect(params).toEqual(['S1', 'S2'])
  })

  it('admin + scope=all 不带权限参数，但仍限制为启用门店', () => {
    const session = makeSession([{ role: 'admin', scopeType: '总部' }], [])
    const { sql, params } = render(scopeFilterSql(session, ALL, 'so.store_id'))
    expect(sql).toContain('active_node.is_active = true')
    expect(params).toEqual([])
  })

  it('非 admin + scope=authorized 汇总全部授权门店，不追加市场或单店条件', () => {
    const session = makeSession([{ role: 'manager', scopeType: '门店' }], ['S1', 'S2'])
    const { sql, params } = render(scopeFilterSql(session, { type: 'authorized' }, 'so.store_id'))
    expect(sql).toContain('so.store_id in')
    expect(sql).not.toContain('with recursive descendants')
    expect(params).toEqual(['S1', 'S2'])
  })
})

describe('scopeFilterSql — UI 选中 scope 收窄', () => {
  it('admin 下钻具体门店 → store_id = $id', () => {
    const session = makeSession([{ role: 'admin', scopeType: '总部' }], [])
    const { sql, params } = render(scopeFilterSql(session, { type: 'store', id: 'STORE-9' }, 'so.store_id'))
    expect(sql).toContain('so.store_id =')
    expect(params).toContain('STORE-9')
  })

  it('admin 下钻市场 → 子查询展开该节点及任意层级下属门店', () => {
    const session = makeSession([{ role: 'admin', scopeType: '总部' }], [])
    const { sql, params } = render(scopeFilterSql(session, { type: 'market', id: 'MKT-1' }, 'so.store_id'))
    expect(sql).toContain('with recursive descendants')
    expect(sql).toContain('join descendants on child.parent_id = descendants.id')
    expect(sql).toContain('where not child.id = any(descendants.path)')
    expect(sql).toContain('s.org_node_id in (')
    expect(sql).toContain('select id from descendants')
    expect(params).toEqual(['MKT-1', 'MKT-1'])
  })

  it('非 admin + 市场下钻 → 账号范围 AND 市场子查询（两段 AND）', () => {
    const session = makeSession([{ role: 'manager', scopeType: '市场' }], ['S1', 'S2'])
    const { sql, params } = render(scopeFilterSql(session, { type: 'market', id: 'MKT-1' }, 'so.store_id'))
    expect(sql).toContain('so.store_id in (')
    expect(sql).toContain(' and ')
    expect(params).toEqual(['S1', 'S2', 'MKT-1', 'MKT-1'])
  })

  it('支持自定义门店列（client 表 bound_store_id）', () => {
    const session = makeSession([{ role: 'manager', scopeType: '门店' }], ['S1'])
    const { sql } = render(scopeFilterSql(session, ALL, 'c.bound_store_id'))
    expect(sql).toContain('c.bound_store_id in')
  })
})

describe('scopeStoreSkeletonSql — 关系骨架（store→market）', () => {
  it('产出 store/market 名称列 + JOIN org_nodes 两次 + scope 内嵌', () => {
    const session = makeSession([{ role: 'admin', scopeType: '总部' }], [])
    const { sql } = render(scopeStoreSkeletonSql(session, ALL))
    expect(sql).toContain('s.store_id')
    expect(sql).toContain('o_mkt.name as market_name')
    expect(sql).toContain('join org_nodes o_store')
    expect(sql).toContain('join org_nodes o_mkt')
    // 即使 admin 全范围也必须排除停用门店
    expect(sql).toContain('active_node.is_active = true')
  })

  it('非 admin 把 scopeStoreIds 内嵌进骨架 WHERE', () => {
    const session = makeSession([{ role: 'manager', scopeType: '市场' }], ['S1', 'S2'])
    const { sql, params } = render(scopeStoreSkeletonSql(session, ALL))
    expect(sql).toContain('s.store_id in')
    expect(params).toEqual(['S1', 'S2'])
  })
})

describe('orgAnchorScopeSql — 无门店员工（直挂组织节点）的可见性', () => {
  const MARKET: DataCenterScope = { type: 'market', id: 'mkt-A' }
  const STORE: DataCenterScope = { type: 'store', id: 'S1' }

  it('UI 选具体门店 → FALSE（无门店员工不归属任何单店）', () => {
    const session = makeSession([{ role: 'admin', scopeType: '总部' }], [])
    const { raw } = render(orgAnchorScopeSql(session, STORE))
    expect(raw.trim().toUpperCase()).toBe('FALSE')
  })

  it('UI 选市场 → 锚定市场须等于该市场', () => {
    const session = makeSession([{ role: 'admin', scopeType: '总部' }], [])
    const { sql, params } = render(orgAnchorScopeSql(session, MARKET))
    expect(sql).toContain('pb.anchor_market_id =')
    expect(params).toEqual(['mkt-A'])
  })

  it('admin + scope=all → TRUE（品项公司等总部直属节点仅此路径可见）', () => {
    const session = makeSession([{ role: 'admin', scopeType: '总部' }], [])
    const { raw } = render(orgAnchorScopeSql(session, ALL))
    expect(raw.trim().toUpperCase()).toBe('TRUE')
  })

  it('非 admin + scope=all → EXISTS(锚定市场下有本账号可见的在营门店)', () => {
    const session = makeSession([{ role: 'manager', scopeType: '市场' }], ['S1', 'S2'])
    const { sql, params } = render(orgAnchorScopeSql(session, ALL))
    expect(sql).toContain('exists (')
    expect(sql).toContain('vn.parent_id = pb.anchor_market_id')
    expect(sql).toContain('vn.is_active = true')
    expect(sql).toContain('vs.store_id in')
    expect(params).toEqual(['S1', 'S2'])
  })

  it('非 admin + 空 scopeStoreIds → FALSE', () => {
    const session = makeSession([{ role: 'manager', scopeType: '门店' }], [])
    const { raw } = render(orgAnchorScopeSql(session, ALL))
    expect(raw.trim().toUpperCase()).toBe('FALSE')
  })
})

describe('orgAnchorScopeSql — 市场分支按「直接授权」收窄（#399）', () => {
  const MKT: DataCenterScope = { type: 'market', id: 'mkt-A' }
  function withNodes(session: AuthSession, scopeOrgNodeIds: string[] | undefined): AuthSession {
    return { ...session, permissions: { ...session.permissions, scopeOrgNodeIds } }
  }

  it('直接授权的市场（hr@品项公司 这类）：只比锚定市场，不要求门店（其下本就无门店）', () => {
    const session = withNodes(makeSession([{ role: 'hr', scopeType: '市场' }], []), ['mkt-A'])
    const { raw, params } = render(orgAnchorScopeSql(session, MKT))
    expect(raw.replace(/\s+/g, ' ').trim()).toBe('pb.anchor_market_id = $1')
    expect(params).toEqual(['mkt-A'])
  })

  it('门店级账号的祖先市场：锚定相等 AND 锚定市场下有本账号可见的在营门店（与 authorized 同口径）', () => {
    const session = withNodes(makeSession([{ role: 'manager', scopeType: '门店' }], ['S1']), ['node-S1'])
    const { sql, params } = render(orgAnchorScopeSql(session, MKT))
    expect(sql).toMatch(/^pb\.anchor_market_id = \$1 and exists \(/)
    expect(sql).toContain('vn.is_active = true')
    expect(sql).toContain('vn.parent_id = pb.anchor_market_id')
    expect(params).toEqual(['mkt-A', 'S1'])
  })

  it('祖先市场 + 无授权门店（唯一门店被停用后被剔除等）→ 锚定分支恒假', () => {
    const session = withNodes(makeSession([{ role: 'manager', scopeType: '门店' }], []), ['node-S1'])
    const { sql } = render(orgAnchorScopeSql(session, MKT))
    expect(sql.replace(/\s+/g, ' ').trim()).toBe('pb.anchor_market_id = $1 and false')
  })

  it('旧会话缺 scopeOrgNodeIds：按未授权处理（保守走可见门店判定）', () => {
    const session = withNodes(makeSession([{ role: 'manager', scopeType: '市场' }], ['S1']), undefined)
    expect(render(orgAnchorScopeSql(session, MKT)).sql).toContain('exists (')
  })

  it('超管：市场分支照旧只比锚定市场', () => {
    const session = withNodes(makeSession([{ role: 'admin', scopeType: '总部' }], []), undefined)
    expect(render(orgAnchorScopeSql(session, MKT)).raw.replace(/\s+/g, ' ').trim()).toBe('pb.anchor_market_id = $1')
  })
})
