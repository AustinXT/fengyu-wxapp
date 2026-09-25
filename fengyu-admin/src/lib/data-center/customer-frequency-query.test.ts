import fs from 'node:fs'
import path from 'node:path'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { SQL } from 'drizzle-orm'
import { PgDialect } from 'drizzle-orm/pg-core'
import type { AuthSession } from '@/lib/types'

/**
 * 顾客频率表取数 SQL（#370）的口径守护：按 Drizzle 实际渲染出的 SQL 断言，不连库。
 *   - 当日消费的款项过滤与销售板「总业绩」（sales.ts runStoreRevenue）逐条相同 —— 「本月消费合计 = 总业绩」的前提
 *   - 寄存单退款专用单只从**消耗**里剔除（FILTER），不影响 ✓ 与服务项目
 *   - ✓ 只来自 visitDaysSql 的到店事件，款项归属日期不产生 ✓
 */

const executed = vi.hoisted(() => ({ queries: [] as unknown[] }))
vi.mock('@/db', () => ({
  db: {
    execute: vi.fn(async (query: unknown) => {
      executed.queries.push(query)
      return []
    }),
  },
}))

import { loadCustomerFrequencySource } from './customer-frequency-query'

const admin = {
  employeeId: 'EMP-ADMIN',
  name: '超管',
  phone: '',
  roles: [{ role: 'admin', scopeId: 'HQ', scopeType: '总部', isSuperAdmin: true }],
  permissions: { actions: [], scopeStoreIds: [] },
} as unknown as AuthSession

const normalize = (value: string) => value.replace(/\s+/g, ' ').trim()

async function renderedQuery(): Promise<string> {
  executed.queries.length = 0
  await loadCustomerFrequencySource(admin, { type: 'all' }, { start: '2026-08-01', end: '2026-08-31' })
  expect(executed.queries).toHaveLength(1)
  return normalize(new PgDialect().sqlToQuery(executed.queries[0] as SQL).sql)
}

/** 取 `name AS (` 到下一个顶层 CTE 之间的片段 */
function cte(query: string, name: string, next: string): string {
  const start = query.indexOf(`${name} AS (`)
  const end = query.indexOf(`${next} AS (`, start)
  expect(start, name).toBeGreaterThanOrEqual(0)
  expect(end, next).toBeGreaterThan(start)
  return query.slice(start, end)
}

/** 款项过滤谓词：`spe.<列> ...` 形态的 WHERE / AND 子句（排除日期区间与 scope，这两项两边本就不同） */
function speFilters(text: string): string[] {
  return (normalize(text).match(/(?:WHERE|AND) spe\.(?:status|change_type|sale_order_type|legacy_source) .*?(?= AND | GROUP BY |$)/g) ?? [])
    .map((clause) => clause.replace(/^(?:WHERE|AND) /, '').trim())
    .sort()
}

beforeEach(() => {
  executed.queries.length = 0
})

describe('顾客频率表取数 SQL 口径守护（#370）', () => {
  it('当日消费的款项过滤与销售板「总业绩」runStoreRevenue 逐条相同，且按款项归属日期取', async () => {
    const query = await renderedQuery()
    const amount = cte(query, 'amount_days', 'service_days')

    const salesSrc = fs.readFileSync(path.resolve(__dirname, '../../actions/data-center/sales.ts'), 'utf-8')
    const fnStart = salesSrc.indexOf('const runStoreRevenue')
    const fnEnd = salesSrc.indexOf('const runShengmeiRevenue')
    const board = speFilters(salesSrc.slice(fnStart, fnEnd))

    // 四条：已支付 / 首次支付·回款·退款 / 销售·转换·充值单 / 非 WorkFine
    expect(board).toHaveLength(4)
    expect(speFilters(amount)).toEqual(board)
    expect(amount).toContain('spe.performance_date BETWEEN')
    expect(amount).not.toMatch(/paid_at/)
    // 同日多笔款项求和（净额），按 (顾客, 归属日) 聚合
    expect(amount).toContain('SUM(spe.amount::numeric) AS amount')
    expect(amount).toContain('GROUP BY so.client_user_id, spe.performance_date')
  })

  it('寄存单退款专用单只从消耗里剔除（FILTER），不影响当日服务项目与 ✓', async () => {
    const query = await renderedQuery()
    const service = cte(query, 'service_days', 'visit_stores')
    expect(service).toMatch(/SUM\(sit\.unit_real_price::numeric \* sit\.session_used\) FILTER \(WHERE so\.remark IS DISTINCT FROM \$\d+\) AS consume/)
    // WHERE 里不得出现 remark：那会把寄存退款单整张剔掉，连同服务项目与发生门店
    const where = service.slice(service.indexOf(' WHERE '))
    expect(where).not.toMatch(/remark/)
    expect(where).toContain("so.status = '已完成'")
  })

  it('(顾客, 日) 键去重：三路事件用 UNION 合并，每个 CTE 每人每天至多一行，外层 LEFT JOIN 不会放大行数', async () => {
    const query = await renderedQuery()
    // PG 关键字大小写不敏感：转小写再断言，改写成 `union all` 也拦得住
    const dayKeys = query.slice(query.indexOf('day_keys AS ('), query.indexOf(') SELECT c.user_id')).toLowerCase()
    expect(dayKeys.match(/ union select /g)).toHaveLength(2)
    expect(dayKeys).not.toMatch(/union all/)
    expect(cte(query, 'service_days', 'visit_stores')).toContain('GROUP BY so.client_user_id, so.service_date')
    expect(cte(query, 'visit_stores', 'day_keys')).toContain('GROUP BY ve.client_user_id, ve.visit_date')
  })

  it('✓ 只来自到店事件集（服务日 ∪ 支付日），款项归属日与消耗日只补金额', async () => {
    const query = await renderedQuery()
    expect(query).toContain('(vd.client_user_id IS NOT NULL) AS visited')
    expect(query).toMatch(/LEFT JOIN visit_days vd ON vd\.client_user_id = k\.client_user_id AND vd\.visit_date = k\.day/)
    // 到店事件与款项、服务都只取范围内顾客（交易跟着顾客走，事件侧不按门店收窄）
    const visit = cte(query, 'visit_days', 'visit_store_events')
    expect(visit.match(/WHERE so\.client_user_id IN \(SELECT user_id FROM cust\)/g)).toHaveLength(2)
    expect(visit).not.toMatch(/store_id IN/)
  })
})
