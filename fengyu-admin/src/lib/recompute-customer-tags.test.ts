import { describe, expect, it, vi } from 'vitest'
import { PgDialect } from 'drizzle-orm/pg-core'
vi.mock('@/db',()=>({db:{}}))
import { recomputeCustomerTagsInTx } from './recompute-customer-tags'

const compile = (s: any) => new PgDialect().sqlToQuery(s)
describe('#257 C 单顾客双向重算', () => {
  it('会员跌破后降为小美；锁内计算，不清历史归因，先分类再状态', async () => {
    const execute = vi.fn().mockResolvedValueOnce([{customer_type:'会员客'}]).mockResolvedValueOnce([{value:'1980'}]).mockResolvedValueOnce([{computed_type:'小美客'}]).mockResolvedValueOnce(Object.assign([{customer_type:'小美客'}],{count:1})).mockResolvedValue([])
    expect(await recomputeCustomerTagsInTx({execute} as never,'U1')).toMatchObject({customerTypeChanged:{from:'会员客',to:'小美客'}})
    const queries = execute.mock.calls.map(([s])=>compile(s))
    expect(queries[0].sql).toContain('FOR NO KEY UPDATE')
    expect(queries[3].sql).toContain('customer_type IS DISTINCT FROM')
    expect(queries[4].sql).toContain('customer_status = NULL')
    expect(queries.some(q=>q.sql.includes('SET became_member_at'))).toBe(false)
    expect(queries.some(q=>q.sql.includes('SET is_membership_upgrade'))).toBe(false)
  })
  it('同档不重复写分类、不打升级标记', async () => {
    const execute = vi.fn().mockResolvedValueOnce([{customer_type:'会员客'}]).mockResolvedValueOnce([{value:'1980'}]).mockResolvedValueOnce([{computed_type:'会员客'}]).mockResolvedValue([])
    expect(await recomputeCustomerTagsInTx({execute} as never,'U1')).toMatchObject({customerTypeChanged:null})
    expect(execute.mock.calls.some(([s])=>compile(s).sql.includes('SET customer_type'))).toBe(false)
  })
  it('阈值失效不写分类、不阻断其余审核标签', async () => {
    const execute = vi.fn().mockResolvedValueOnce([{customer_type:'会员客'}]).mockResolvedValueOnce([]).mockResolvedValue([])
    expect(await recomputeCustomerTagsInTx({execute} as never,'U1')).toMatchObject({customerTypeChanged:null})
    expect(execute.mock.calls.some(([s])=>compile(s).sql.includes('SET customer_type'))).toBe(false)
  })
})
