/**
 * ticket 2026-04-24 PR-A：getProductsByKind 新增 '__normal__' 分支 + 排除法。
 *
 * 测试重点（ticket §4.2）：
 * 1. `__normal__` 返回 `{ kind:'__normal__', groups: [{ productKind, categories }] }`
 *    且不包含 '充值卡' / '体验卡'
 * 2. 新增一级行'福利活动' + 二级 + SKU → 自动出现在 __normal__ 返回（排除法语义）
 * 3. groups 顺序按一级行 sortOrder
 * 4. 空分类（无有效 SKU）不出现
 *
 * 注：2026-05-26 起普通商品不再因「SKU 进过套餐」而隐藏（取消 NOT EXISTS bundle 谓词），
 *    SKU 既可单卖也可进套餐，互不影响。
 * 5. '充值卡' 仍返回平铺结构，仅 productKind='充值卡'
 * 6. '__bundle__' 无匹配套餐时返回空列表
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/db', () => ({
  db: {
    select: vi.fn(),
    insert: vi.fn(),
    update: vi.fn(),
    delete: vi.fn(),
    transaction: vi.fn(),
  },
}))

vi.mock('@db/product', () => ({
  productCategories: {
    categoryId: 'category_id',
    categoryName: 'category_name',
    productKind: 'product_kind',
    salesCategory: 'sales_category',
    sortOrder: 'sort_order',
    isValid: 'is_valid',
    updatedAt: 'updated_at',
  },
  products: {
    productId: 'product_id',
    categoryId: 'category_id',
    isBundle: 'is_bundle',
    isVisible: 'is_visible',
    marketScope: 'market_scope',
    sortOrder: 'sort_order',
    deletedAt: 'deleted_at',
  },
  productSkus: {
    skuId: 'sku_id',
    categoryId: 'category_id',
    productType: 'product_type',
    specName: 'spec_name',
    price: 'price',
    specialPrice: 'special_price',
    sessionCount: 'session_count',
    purchaseLimit: 'purchase_limit',
    serviceFee: 'service_fee',
    sortOrder: 'sort_order',
    isEnabled: 'is_enabled',
    isExperience: 'is_experience',
    isRechargeCard: 'is_recharge_card',
    marketScope: 'market_scope',
    deletedAt: 'deleted_at',
  },
  mallCategories: {
    categoryId: 'category_id',
    updatedAt: 'updated_at',
  },
  mallBundleGroups: {
    id: 'id',
    productId: 'product_id',
    sortOrder: 'sort_order',
  },
  mallProductSkus: {
    productId: 'product_id',
    skuId: 'sku_id',
    bundleGroupId: 'bundle_group_id',
    bundlePrice: 'bundle_price',
    sortOrder: 'sort_order',
  },
}))

vi.mock('@db/org', () => ({
  stores: {
    storeId: 'store_id',
    orgNodeId: 'org_node_id',
  },
  orgNodes: {
    id: 'id',
    name: 'name',
    type: 'type',
    isActive: 'is_active',
    sortOrder: 'sort_order',
    parentId: 'parent_id',
  },
}))

vi.mock('@db/user', () => ({
  clientWechatUsers: {
    userId: 'user_id',
    boundStoreId: 'bound_store_id',
    isCrossStoreTemp: 'is_cross_store_temp',
  },
}))

vi.mock('@db/order', () => ({
  saleItems: { saleItemId: 'sale_item_id', skuId: 'sku_id' },
}))

vi.mock('drizzle-orm', () => ({
  eq: vi.fn((a, b) => ({ type: 'eq', a, b })),
  and: vi.fn((...args) => ({ type: 'and', args })),
  or: vi.fn((...args) => ({ type: 'or', args })),
  asc: vi.fn((a) => ({ type: 'asc', a })),
  sql: Object.assign(
    vi.fn((...args: unknown[]) => ({ type: 'sql', args })),
    { raw: vi.fn() },
  ),
  inArray: vi.fn((col, vals) => ({ type: 'inArray', col, vals })),
  notInArray: vi.fn((col, vals) => ({ type: 'notInArray', col, vals })),
  isNotNull: vi.fn((a) => ({ type: 'isNotNull', a })),
  isNull: vi.fn((a) => ({ type: 'isNull', a })),
}))

vi.mock('drizzle-orm/pg-core', () => ({
  alias: vi.fn((table, name) => ({ ...table, _alias: name })),
}))

vi.mock('@/lib/auth', () => ({
  getSession: vi.fn(),
}))

vi.mock('@/lib/permissions', () => ({
  requirePermission: vi.fn(),
}))

vi.mock('@/lib/operation-log', () => ({
  logOperation: vi.fn(),
  logUpdate: vi.fn(),
  logTransition: vi.fn(),
}))

vi.mock('next/cache', () => ({
  revalidatePath: vi.fn(),
}))

import { getProductsByKind } from '../products'
import { db } from '@/db'
import { getSession } from '@/lib/auth'

const mockSession = {
  employeeId: 'MGR-001',
  roles: [{ role: 'admin', scopeId: 'hq' }],
  permissions: { actions: ['product:list'], scopeStoreIds: [] },
}

/**
 * 构造 drizzle select 链式 mock：
 *   db.select().from().innerJoin().innerJoin().where().orderBy() → rows
 * 或                .from().where().orderBy() → rows
 *
 * 返回 `where` mock fn，便于断言 WHERE 子句结构。
 */
function mockChain(rows: unknown[]) {
  const orderBy = vi.fn().mockResolvedValue(rows)
  const where = vi.fn().mockReturnValue({ orderBy })
  const innerJoin2 = vi.fn().mockReturnValue({ where, orderBy })
  const innerJoin1 = vi.fn().mockReturnValue({ innerJoin: innerJoin2, where, orderBy })
  const from = vi.fn().mockReturnValue({ innerJoin: innerJoin1, where, orderBy })
  ;(db.select as any).mockReturnValueOnce({ from })
  return where
}

function mockCustomerMarketScope(row: unknown) {
  const limit = vi.fn().mockResolvedValue([row])
  const where = vi.fn().mockReturnValue({ limit })
  const chain: Record<string, unknown> = { where }
  chain.leftJoin = vi.fn().mockReturnValue(chain)
  const from = vi.fn().mockReturnValue(chain)
  ;(db.select as any).mockReturnValueOnce({ from })
}

describe("getProductsByKind('__normal__') — 排除法 + 分组", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    ;(getSession as any).mockResolvedValue(mockSession)
  })

  function row(overrides: {
    kindName: string
    kindSortOrder: number
    categoryId: string
    categoryName: string
    categorySortOrder: number
    skuId: string
    specName: string
  }) {
    return {
      category: {
        categoryId: overrides.categoryId,
        categoryName: overrides.categoryName,
        productKind: overrides.kindName,
        salesCategory: '自销自耗',
        sortOrder: overrides.categorySortOrder,
      },
      sku: {
        skuId: overrides.skuId,
        categoryId: overrides.categoryId,
        productType: '家居产品',
        specName: overrides.specName,
        price: '100',
        specialPrice: null,
        sessionCount: null,
        serviceFee: '0',
        sortOrder: 1,
      },
      parentProductKind: overrides.kindName,
      parentSortOrder: overrides.kindSortOrder,
    }
  }

  it('返回 kind=__normal__ 且 groups 仅含非卡类', async () => {
    mockChain([
      row({ kindName: '护理项目', kindSortOrder: 2, categoryId: 'cat-hr-01', categoryName: '面部护理', categorySortOrder: 1, skuId: 'SKU-1', specName: '面部护理单次' }),
      row({ kindName: '家居产品', kindSortOrder: 3, categoryId: 'cat-jj-01', categoryName: '护肤品', categorySortOrder: 1, skuId: 'SKU-2', specName: '精华液' }),
    ])

    const result = await getProductsByKind('__normal__')
    expect(result.kind).toBe('__normal__')
    if (!('groups' in result)) throw new Error('expected __normal__ with groups')

    expect(result.groups).toHaveLength(2)
    const kinds = result.groups.map((g) => g.productKind)
    expect(kinds).not.toContain('充值卡')
    expect(kinds).not.toContain('体验卡')
    expect(kinds).toEqual(['护理项目', '家居产品'])
  })

  it('排除法语义：新增"福利活动"一级行 + 二级 + SKU 自动出现', async () => {
    mockChain([
      row({ kindName: '护理项目', kindSortOrder: 2, categoryId: 'cat-hr-01', categoryName: '面部护理', categorySortOrder: 1, skuId: 'SKU-1', specName: 'A' }),
      row({ kindName: '福利活动', kindSortOrder: 6, categoryId: 'cat-welfare-01', categoryName: '新人礼', categorySortOrder: 1, skuId: 'SKU-NEW', specName: '新人礼包' }),
    ])

    const result = await getProductsByKind('__normal__')
    if (!('groups' in result)) throw new Error('expected __normal__ with groups')
    const welfare = result.groups.find((g) => g.productKind === '福利活动')
    expect(welfare).toBeDefined()
    expect(welfare!.categories[0].categoryName).toBe('新人礼')
    expect(welfare!.categories[0].skus[0].skuId).toBe('SKU-NEW')
  })

  it('groups 顺序按一级行 sortOrder（家居产品 sort=3 排在 护理项目 sort=2 之后）', async () => {
    // DB 已按 parent.sort_order ASC 返回，测 aggregator 保留顺序
    mockChain([
      row({ kindName: '护理项目', kindSortOrder: 2, categoryId: 'cat-hr-01', categoryName: '面部护理', categorySortOrder: 1, skuId: 'SKU-1', specName: 'A' }),
      row({ kindName: '护理项目', kindSortOrder: 2, categoryId: 'cat-hr-02', categoryName: '身体护理', categorySortOrder: 2, skuId: 'SKU-2', specName: 'B' }),
      row({ kindName: '家居产品', kindSortOrder: 3, categoryId: 'cat-jj-01', categoryName: '护肤品', categorySortOrder: 1, skuId: 'SKU-3', specName: 'C' }),
    ])

    const result = await getProductsByKind('__normal__')
    if (!('groups' in result)) throw new Error('expected __normal__ with groups')
    expect(result.groups[0].productKind).toBe('护理项目')
    expect(result.groups[1].productKind).toBe('家居产品')
    // 组内按二级行 sortOrder
    expect(result.groups[0].categories.map((c) => c.categoryName)).toEqual(['面部护理', '身体护理'])
  })

  it('空分类（无有效 SKU）不出现 — SQL 层已过滤，rows 不含该分类', async () => {
    // 模拟 DB 已过滤过：某 productKind="福利活动"的分类因无 SKU 未返回
    mockChain([
      row({ kindName: '护理项目', kindSortOrder: 2, categoryId: 'cat-hr-01', categoryName: '面部护理', categorySortOrder: 1, skuId: 'SKU-1', specName: 'A' }),
    ])

    const result = await getProductsByKind('__normal__')
    if (!('groups' in result)) throw new Error('expected __normal__ with groups')
    expect(result.groups).toHaveLength(1)
    expect(result.groups[0].productKind).toBe('护理项目')
    // 所有组均非空
    for (const g of result.groups) {
      expect(g.categories.length).toBeGreaterThan(0)
    }
  })

  it('前端防御：即使 rows 返回的某 group categories 全空，仍过滤掉', async () => {
    // 这种情况理论上不会发生（SQL EXISTS 保证），但组件前端仍防御
    // 直接以 rows=[] 构造 → groups 应为空
    mockChain([])
    const result = await getProductsByKind('__normal__')
    if (!('groups' in result)) throw new Error('expected __normal__ with groups')
    expect(result.groups).toEqual([])
  })

  it('传入顾客时按绑定门店市场过滤普通 SKU', async () => {
    mockCustomerMarketScope({
      isCrossStoreTemp: false,
      marketId: 'market-east',
      marketName: '华东市场',
    })
    const where = mockChain([])

    await getProductsByKind('__normal__', 'customer-1')

    const whereArg = where.mock.calls[0][0] as { type: string; args: Array<{ type?: string }> }
    expect(whereArg.type).toBe('and')
    expect(whereArg.args.some((condition) => condition.type === 'or')).toBe(true)
  })

  it('未传顾客时保守地只返回全市场普通 SKU', async () => {
    const where = mockChain([])

    await getProductsByKind('__normal__')

    const whereArg = where.mock.calls[0][0] as {
      type: string
      args: Array<{ type?: string; a?: string }>
    }
    expect(whereArg.type).toBe('and')
    expect(whereArg.args).toContainEqual({ type: 'isNull', a: 'market_scope' })
  })
})

// 充值卡剥离 SKU 化（2026-05-20）：充值卡退出 SKU/商品域，getProductsByKind('充值卡')
// 分支已删除，原测试组不再适用。后续 admin 若新增充值订单入口会另起独立 action。

describe("getProductsByKind('体验卡') — SKU capability 列过滤", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    ;(getSession as any).mockResolvedValue(mockSession)
  })

  it("'体验卡' 用 SKU capability is_experience=true 过滤，不依赖 product_kind 字面量", async () => {
    const where = mockChain([])

    await getProductsByKind('体验卡')

    const whereArg = where.mock.calls[0][0] as { type: string; args: Array<{ type: string; a: string; b: unknown }> }
    expect(whereArg.type).toBe('and')
    const eqConditions = whereArg.args.filter((c) => c.type === 'eq')
    const hasExperienceFilter = eqConditions.some((c) => c.a === 'is_experience' && c.b === true)
    expect(hasExperienceFilter).toBe(true)
    const hasProductKindFilter = eqConditions.some((c) => c.a === 'product_kind' && c.b === '体验卡')
    expect(hasProductKindFilter).toBe(false)
  })

  it("即使 SKU 所属分类的 productKind 非'体验卡'，is_experience=true 的 SKU 仍纳入结果", async () => {
    // 边界场景：管理员把一个 is_experience=true SKU 错挂到 productKind='护理项目' 分类下
    // capability 是 SSoT，'体验卡' Tab 应该展示该 SKU
    mockChain([
      {
        category: {
          categoryId: 'cat-hr-01',
          categoryName: '面部护理',
          productKind: '护理项目',
          salesCategory: '自销自耗',
          sortOrder: 1,
        },
        sku: {
          skuId: 'SKU-MISPLACED-TRIAL',
          categoryId: 'cat-hr-01',
          productType: '家居产品',
          specName: '体验单次',
          price: '99',
          specialPrice: null,
          sessionCount: null,
          serviceFee: '0',
          sortOrder: 1,
        },
      },
    ])

    const result = await getProductsByKind('体验卡')
    expect(result.kind).toBe('体验卡')
    if (!('categories' in result)) throw new Error('expected flat categories')
    expect(result.categories).toHaveLength(1)
    expect(result.categories[0].skus[0].skuId).toBe('SKU-MISPLACED-TRIAL')
  })
})

describe("getProductsByKind('__bundle__') — 套餐范围筛选", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    ;(getSession as any).mockResolvedValue(mockSession)
  })

  it('空套餐列表 → 返回 bundles: []', async () => {
    // __bundle__ 分支首个 select：products WHERE is_bundle=true...
    const orderBy = vi.fn().mockResolvedValue([])
    const where = vi.fn().mockReturnValue({ orderBy })
    const from = vi.fn().mockReturnValue({ where })
    ;(db.select as any).mockReturnValueOnce({ from })

    const result = await getProductsByKind('__bundle__')
    expect(result.kind).toBe('__bundle__')
    if (!('bundles' in result)) throw new Error('expected __bundle__ with bundles')
    expect(result.bundles).toEqual([])
  })
})
