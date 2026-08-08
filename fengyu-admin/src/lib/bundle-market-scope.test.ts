import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/db', () => ({ db: { select: vi.fn() } }))

import { PgDialect } from 'drizzle-orm/pg-core'
import { products } from '@db/product'
import { db } from '@/db'
import { bundleMarketScopeCondition, resolveCustomerBundleMarketScope } from './bundle-market-scope'

const dialect = new PgDialect()

function render(scope: Parameters<typeof bundleMarketScopeCondition>[1]) {
  const query = dialect.sqlToQuery(bundleMarketScopeCondition(products.marketScope, scope))
  return { sql: query.sql.toLowerCase(), params: query.params }
}

function mockCustomerScopeRow(row: unknown) {
  const limit = vi.fn().mockResolvedValue(row == null ? [] : [row])
  const where = vi.fn().mockReturnValue({ limit })
  const chain: Record<string, unknown> = { where }
  chain.leftJoin = vi.fn().mockReturnValue(chain)
  const from = vi.fn().mockReturnValue(chain)
  ;(db.select as ReturnType<typeof vi.fn>).mockReturnValue({ from })
}

describe('resolveCustomerBundleMarketScope', () => {
  beforeEach(() => vi.clearAllMocks())

  it('临时共享顾客允许所有已配置市场范围套餐', async () => {
    mockCustomerScopeRow({ isCrossStoreTemp: true, marketId: 'market-a', marketName: '市场A' })

    await expect(resolveCustomerBundleMarketScope('customer-1')).resolves.toEqual({ type: 'allConfigured' })
  })

  it('普通顾客使用绑定门店所属市场，而不是前端选中的开单门店', async () => {
    mockCustomerScopeRow({ isCrossStoreTemp: false, marketId: 'market-bound', marketName: '绑定市场' })

    await expect(resolveCustomerBundleMarketScope('customer-1')).resolves.toEqual({
      type: 'market',
      marketId: 'market-bound',
      marketName: '绑定市场',
    })
  })

  it('无有效绑定门店时保守地只允许全市场套餐', async () => {
    mockCustomerScopeRow({ isCrossStoreTemp: false, marketId: null, marketName: null })

    await expect(resolveCustomerBundleMarketScope('customer-1')).resolves.toEqual({ type: 'globalOnly' })
  })
})

describe('bundleMarketScopeCondition', () => {
  it('未识别到顾客绑定市场时仅返回全市场套餐', () => {
    const { sql, params } = render({ type: 'globalOnly' })

    expect(sql).toContain('"products"."market_scope" is null')
    expect(sql).not.toContain('string_to_array')
    expect(params).toEqual([])
  })

  it('临时跨店顾客允许全市场和任何已配置市场范围，排除空白范围', () => {
    const { sql, params } = render({ type: 'allConfigured' })

    expect(sql).toContain('"products"."market_scope" is null')
    expect(sql).toContain("nullif(regexp_replace")
    expect(sql).toContain("'[[:space:]]+'")
    expect(params).toEqual([])
  })

  it('普通顾客按市场 ID 或历史市场名匹配，比较时忽略空白', () => {
    const { sql, params } = render({
      type: 'market',
      marketId: 'market-east',
      marketName: '华 东 市场',
    })

    expect(sql).toContain('string_to_array(regexp_replace')
    expect(sql).toContain('= any(')
    expect(params).toEqual(['market-east', '华东市场'])
  })
})
