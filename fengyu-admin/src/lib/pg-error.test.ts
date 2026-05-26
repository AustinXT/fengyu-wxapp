import { describe, it, expect } from 'vitest'
import { pgErrorCode, pgErrorConstraint } from './pg-error'

/** 模拟 drizzle 0.44+ 的包装错误：外层 Failed query，真实 pg 错误在 cause。 */
function wrappedPgError(code: string, constraint?: string) {
  const inner = Object.assign(new Error('duplicate key value violates unique constraint'), {
    code,
    ...(constraint ? { constraint_name: constraint } : {}),
  })
  return Object.assign(new Error('Failed query: insert into ...'), { cause: inner })
}

describe('pgErrorCode', () => {
  it('扁平错误（旧 drizzle / 直接 pg 错误）', () => {
    expect(pgErrorCode(Object.assign(new Error('x'), { code: '23505' }))).toBe('23505')
  })

  it('单层 cause 包装（drizzle 0.44+）', () => {
    expect(pgErrorCode(wrappedPgError('23505'))).toBe('23505')
  })

  it('多层 cause 包装', () => {
    const deep = Object.assign(new Error('outer'), { cause: wrappedPgError('23503') })
    expect(pgErrorCode(deep)).toBe('23503')
  })

  it('无 pg 错误码 → undefined', () => {
    expect(pgErrorCode(new Error('connection lost'))).toBeUndefined()
    expect(pgErrorCode(null)).toBeUndefined()
    expect(pgErrorCode('boom')).toBeUndefined()
  })

  it('忽略非 5 位的 code', () => {
    expect(pgErrorCode(Object.assign(new Error('x'), { code: 'ECONNRESET' }))).toBeUndefined()
  })
})

describe('pgErrorConstraint', () => {
  it('从 cause 链取 constraint_name', () => {
    expect(pgErrorConstraint(wrappedPgError('23505', 'uq_stores_org_node_id'))).toBe('uq_stores_org_node_id')
  })

  it('兼容扁平 constraint 字段', () => {
    expect(pgErrorConstraint(Object.assign(new Error('x'), { constraint: 'uq_org_nodes_parent_name' }))).toBe(
      'uq_org_nodes_parent_name',
    )
  })

  it('无约束名 → undefined', () => {
    expect(pgErrorConstraint(wrappedPgError('23505'))).toBeUndefined()
  })
})
