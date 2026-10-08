import { describe, expect, it, vi } from 'vitest'
import { PgDialect } from 'drizzle-orm/pg-core'
import { resolve } from 'node:path'
import { readFileSync } from 'node:fs'
import { customerTypeBatchSql, refreshCustomerTypes, CUSTOMER_TYPE_AMOUNTS_SQL } from '../steps/refresh-customer-types'

describe('#545 每日分类重算（只升不降，推翻 #257）', () => {
  it.each([[], [{value:''}], [{value:'  '}], [{value:'0'}], [{value:'Infinity'}], [{value:'no'}]].map(rows => ({rows})))('阈值不可用时拒绝写入 %j', async ({rows}) => {
    const execute = vi.fn().mockResolvedValue(rows)
    await expect(refreshCustomerTypes({transaction: (fn: Function) => fn({execute})} as never)).rejects.toThrow('会员门槛')
    expect(execute).toHaveBeenCalledTimes(1)
  })
  it('使用新鲜有效阈值，数值参数化，结果按postgres.js count取值', async () => {
    const execute = vi.fn().mockResolvedValueOnce([{value:'1980'}]).mockResolvedValueOnce({count:3})
    const transaction = vi.fn((fn: Function, _options: unknown) => fn({execute}))
    expect(await refreshCustomerTypes({transaction} as never)).toEqual({updated:3})
    expect(transaction.mock.calls[0][1]).toEqual({isolationLevel:'repeatable read'})
    const q = new PgDialect().sqlToQuery(execute.mock.calls[1][0])
    expect(q.params).toEqual([1980, 1980])
    expect(q.sql).toContain('u.customer_type IS DISTINCT FROM c.new_type')
    expect(q.sql).not.toContain('SET member_level')
    expect(q.sql).toContain('COALESCE(u.became_member_at, c.first_qualified_at)')
    expect(q.sql).toContain('SET is_membership_upgrade = true')
    // #545：目标档位是 max(现值, 计算值) —— 单调包裹存在，且分类结果列改名为 computed_type
    // （只读中间量），写入列 new_type 由 monotonic CTE 产出。
    expect(q.sql).toContain('monotonic AS (')
    expect(q.sql).toContain('END::customer_type AS computed_type')
    expect(q.sql).toContain('FROM monotonic c')
    for (const lvl of ["WHEN '流量客' THEN 0", "WHEN '体验客' THEN 1", "WHEN '小美客' THEN 2", "WHEN '会员客' THEN 3"]) {
      expect(q.sql).toContain(lvl)
    }
  })
  it('金额CTE与离线脚本独立副本逐字对齐', () => {
    const src = readFileSync(resolve(__dirname, '../../../../db/scripts/recalc-all-customer-types.js'),'utf8')
    const cte = src.match(/WITH membership_settings AS \([\s\S]*?FROM membership_amounts a CROSS JOIN membership_settings cfg\s*\)/)![0]
    expect(CUSTOMER_TYPE_AMOUNTS_SQL.trim().replace('(SELECT v FROM threshold)', '$1')).toBe(cte.trim())
  })
  it('每日分类排在状态、等级、权益之前，且测试账号被保护', () => {
    const run = readFileSync(resolve(__dirname, '../run.ts'),'utf8')
    for(const step of ['customerStatus','memberLevels','birthday']) expect(run.indexOf("['customerTypes'")).toBeLessThan(run.indexOf("['"+step+"'"))
    expect(new PgDialect().sqlToQuery(customerTypeBatchSql(1980)).sql).toContain("u.name IS DISTINCT FROM '谢廷(测试)'")
  })
})
