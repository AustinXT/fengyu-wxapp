import { describe, expect, it } from 'vitest'
import { sql } from 'drizzle-orm'
import { PgDialect } from 'drizzle-orm/pg-core'
import { matrixOrderBySql, parseMatrixSort } from './matrix-order'

const dialect = new PgDialect()
const SORTABLE = {
  sales: sql`t.sales_amount`,
  name: sql`c.name`,
}
const FALLBACK = { key: 'sales', direction: 'desc' as const }

describe('parseMatrixSort', () => {
  it('白名单内的 key 与方向原样采用', () => {
    expect(parseMatrixSort({ sort: 'name', dir: 'asc' }, ['sales', 'name'], FALLBACK)).toEqual({ key: 'name', direction: 'asc' })
  })

  it('key 不在白名单 / 缺失 → 回退默认；方向非法 → desc', () => {
    expect(parseMatrixSort({ sort: 'x; DROP TABLE', dir: 'asc' }, ['sales'], FALLBACK)).toEqual(FALLBACK)
    expect(parseMatrixSort({}, ['sales'], FALLBACK)).toEqual(FALLBACK)
    expect(parseMatrixSort({ sort: 'sales', dir: 'ASC ' }, ['sales'], FALLBACK)).toEqual({ key: 'sales', direction: 'desc' })
  })
})

describe('matrixOrderBySql', () => {
  it('排序列 NULLS LAST + 唯一键升序兜底（#282）', () => {
    const query = dialect.sqlToQuery(matrixOrderBySql({ key: 'sales', direction: 'asc' }, SORTABLE, [sql`c.customer_id`]))
    expect(query.sql).toBe('t.sales_amount ASC NULLS LAST, c.customer_id ASC')
    expect(query.params).toEqual([])
  })

  it('降序 + 多个兜底键', () => {
    const query = dialect.sqlToQuery(matrixOrderBySql({ key: 'name', direction: 'desc' }, SORTABLE, [sql`c.store_id`, sql`c.customer_id`]))
    expect(query.sql).toBe('c.name DESC NULLS LAST, c.store_id ASC, c.customer_id ASC')
  })

  it('没有兜底键 / key 不在白名单（含原型链属性）→ 抛错', () => {
    expect(() => matrixOrderBySql(FALLBACK, SORTABLE, [])).toThrow(/唯一键/)
    expect(() => matrixOrderBySql({ key: 'toString', direction: 'asc' }, SORTABLE, [sql`id`])).toThrow(/INVALID_PARAMS/)
  })
})
