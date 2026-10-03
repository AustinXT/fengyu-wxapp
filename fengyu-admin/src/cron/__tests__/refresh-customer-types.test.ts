import { describe, expect, it, vi } from 'vitest'
import { PgDialect } from 'drizzle-orm/pg-core'
import { readFileSync } from 'node:fs'
import { customerTypeBatchSql, refreshCustomerTypes, CUSTOMER_TYPE_AMOUNTS_SQL } from '../steps/refresh-customer-types'

describe('#257 C 每日分类重算', () => {
  it.each([[], [{value:''}], [{value:'  '}], [{value:'0'}], [{value:'Infinity'}], [{value:'no'}]].map(rows => ({rows})))('阈值不可用时拒绝写入 %j', async ({rows}) => {
    const execute = vi.fn().mockResolvedValue(rows)
    await expect(refreshCustomerTypes({transaction: (fn: Function) => fn({execute})} as never)).rejects.toThrow('会员门槛')
    expect(execute).toHaveBeenCalledTimes(1)
  })
  it('使用新鲜有效阈值，数值参数化，结果按postgres.js count取值', async () => {
    const execute = vi.fn().mockResolvedValueOnce([{value:'1980'}]).mockResolvedValueOnce({count:3})
    expect(await refreshCustomerTypes({transaction: (fn: Function) => fn({execute})} as never)).toEqual({updated:3})
    const q = new PgDialect().sqlToQuery(execute.mock.calls[1][0])
    expect(q.params).toEqual([1980])
    expect(q.sql).toContain('u.customer_type IS DISTINCT FROM c.new_type')
    expect(q.sql).not.toContain('SET member_level')
    expect(q.sql).toContain('COALESCE(u.became_member_at, c.first_qualified_at)')
    expect(q.sql).toContain('SET is_membership_upgrade = true')
  })
  it('金额CTE与离线脚本独立副本逐字对齐', () => {
    const src = readFileSync('../db/scripts/recalc-all-customer-types.js','utf8')
    const cte = src.slice(src.indexOf('refund_by_item AS ('),src.indexOf(',\nqualified_orders AS ('))
    expect(CUSTOMER_TYPE_AMOUNTS_SQL.trim()).toBe(('WITH\n'+cte).trim())
  })
  it('每日分类排在状态、等级、权益之前，且测试账号被保护', () => {
    const run = readFileSync('src/cron/run.ts','utf8')
    for(const step of ['customerStatus','memberLevels','birthday']) expect(run.indexOf("['customerTypes'")).toBeLessThan(run.indexOf("['"+step+"'"))
    expect(new PgDialect().sqlToQuery(customerTypeBatchSql(1980)).sql).toContain("u.name IS DISTINCT FROM '谢廷(测试)'")
  })
})
