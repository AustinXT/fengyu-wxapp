import { describe, expect, it, vi } from 'vitest'
import { PgDialect } from 'drizzle-orm/pg-core'
vi.mock('@/db',()=>({db:{}}))
import { recomputeCustomerTagsInTx, recomputeCustomerTypeOnRefund } from './recompute-customer-tags'

const compile = (s: any) => new PgDialect().sqlToQuery(s)
describe('#545 单顾客分类重算（只升不降，推翻 #257）', () => {
  it('会员客早退：不跑金额 CTE、不写分类，先分类再状态', async () => {
    const execute = vi.fn().mockResolvedValueOnce([{customer_type:'会员客'}]).mockResolvedValue([])
    expect(await recomputeCustomerTagsInTx({execute} as never,'U1')).toMatchObject({customerTypeChanged:null})
    const queries = execute.mock.calls.map(([s])=>compile(s))
    expect(queries[0].sql).toContain('FOR NO KEY UPDATE')
    // 早退：第二条就是状态重算，没有 threshold / computed_type / 分类 UPDATE
    expect(queries[1].sql).toContain('customer_status')
    expect(execute.mock.calls.some(([s])=>compile(s).sql.includes('SET customer_type'))).toBe(false)
    expect(queries.some(q=>q.sql.includes('SET became_member_at'))).toBe(false)
    expect(queries.some(q=>q.sql.includes('SET is_membership_upgrade'))).toBe(false)
  })
  it('非会员客也只升不降：计算档位更低时被 rank 守卫挡住', async () => {
    const execute = vi.fn()
      .mockResolvedValueOnce([{customer_type:'小美客'}])
      .mockResolvedValueOnce([{value:'1980'}])
      .mockResolvedValueOnce([{computed_type:'流量客'}])
      .mockResolvedValueOnce([])
      .mockResolvedValue([])
    expect(await recomputeCustomerTagsInTx({execute} as never,'U1')).toMatchObject({customerTypeChanged:null})
    const upd = execute.mock.calls.map(([s])=>compile(s)).find(q=>q.sql.includes('SET customer_type'))!
    expect(upd.sql).toContain('customer_type IS DISTINCT FROM')
    // rank 守卫：现值 < 计算值才写；默认不放行降档（绑定参数为 false）
    expect(upd.sql).toMatch(/END\s*\)\s*<\s*\(\s*CASE/)
    expect(upd.sql).toContain("WHEN '会员客' THEN 3")
    expect(upd.sql).toContain('::boolean')
  })
  it('退款通道放开降档：会员客按剩余有效订单降到小美客', async () => {
    const execute = vi.fn()
      .mockResolvedValueOnce([{customer_type:'会员客'}])
      .mockResolvedValueOnce([{value:'1980'}])
      .mockResolvedValueOnce([{computed_type:'小美客'}])
      .mockResolvedValueOnce(Object.assign([{customer_type:'小美客'}],{count:1}))
      .mockResolvedValue([])
    expect(await recomputeCustomerTypeOnRefund({execute} as never,'U1')).toEqual({from:'会员客',to:'小美客'})
    const upd = execute.mock.calls.map(([s])=>compile(s)).find(q=>q.sql.includes('SET customer_type'))!
    expect(upd.params).toContain(true)
    // 降档不清历史归因
    expect(execute.mock.calls.some(([s])=>compile(s).sql.includes('SET became_member_at'))).toBe(false)
    expect(execute.mock.calls.some(([s])=>compile(s).sql.includes('SET is_membership_upgrade'))).toBe(false)
  })
  it('同档不重复写分类、不打升级标记', async () => {
    const execute = vi.fn().mockResolvedValueOnce([{customer_type:'小美客'}]).mockResolvedValueOnce([{value:'1980'}]).mockResolvedValueOnce([{computed_type:'小美客'}]).mockResolvedValue([])
    expect(await recomputeCustomerTagsInTx({execute} as never,'U1')).toMatchObject({customerTypeChanged:null})
    expect(execute.mock.calls.some(([s])=>compile(s).sql.includes('SET customer_type'))).toBe(false)
  })
  it('阈值失效不写分类、不阻断其余审核标签', async () => {
    const execute = vi.fn().mockResolvedValueOnce([{customer_type:'小美客'}]).mockResolvedValueOnce([]).mockResolvedValue([])
    expect(await recomputeCustomerTagsInTx({execute} as never,'U1')).toMatchObject({customerTypeChanged:null})
    expect(execute.mock.calls.some(([s])=>compile(s).sql.includes('SET customer_type'))).toBe(false)
  })
})
