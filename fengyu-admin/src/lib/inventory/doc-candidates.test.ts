import { beforeEach, describe, expect, it, vi } from 'vitest'
import { PgDialect } from 'drizzle-orm/pg-core'

const { mockDb, mockGetSession } = vi.hoisted(() => ({
  mockDb: {
    execute: vi.fn(),
    insert: vi.fn(),
    select: vi.fn(),
    update: vi.fn(),
    delete: vi.fn(),
    transaction: vi.fn(),
  },
  mockGetSession: vi.fn(),
}))

vi.mock('@/db', () => ({ db: mockDb }))
vi.mock('@/lib/auth', () => ({ getSession: mockGetSession }))
vi.mock('@/lib/permissions', () => ({
  hasPermission: vi.fn(() => true),
  isAdminScope: vi.fn(() => false),
  requireAnyPermission: vi.fn(),
  requirePermission: vi.fn(),
}))
vi.mock('@/lib/operation-log', () => ({ logOperation: vi.fn() }))
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }))

import { getInventoryCoreDocsByIds, listInventoryDocCandidateIds, listInventoryDocCandidates, listStoreUnallocatedRequestSkus } from './engine'
import {
  INVENTORY_DOC_CANDIDATES,
  INVENTORY_DOC_CANDIDATE_BULK_LIMIT,
  INVENTORY_DOC_CANDIDATE_PURPOSES,
  resolveInventoryDocCandidate,
} from './doc-candidates'
import { INVENTORY_OPERATION_DOC_QUERY } from './operation-doc-types'
import { hasPermission, isAdminScope } from '@/lib/permissions'

/*
 * 断言落在编译后的 SQL 文本 + 参数上（理由同 engine.test.ts 的 compile 注释：
 * 遍历条件对象找字符串会被表元数据里的列名假阳性）。
 */
function compile(fragment: unknown) {
  const compiled = new PgDialect().sqlToQuery(fragment as Parameters<PgDialect['sqlToQuery']>[0])
  return { text: compiled.sql, params: compiled.params.map((param) => String(param)) }
}

function marketSession(scopeOrgNodeIds: string[]) {
  return {
    employeeId: 'E-MKT-A',
    name: '市场A库存',
    phone: '13800000000',
    roles: [{
      role: 'inventory_market_operator', scopeId: scopeOrgNodeIds[0], scopeType: '市场',
      actions: ['inventory:list'], scopeStoreIds: [], scopeOrgNodeIds,
    }],
    permissions: { actions: ['inventory:list'], scopeStoreIds: [], scopeOrgNodeIds },
  } as never
}

interface Captured { countWhere?: unknown; listWhere?: unknown; orderBy?: unknown[]; limit?: number; offset?: number }

/** COUNT 与 LIST 各自的 sink：共用一个会让「COUNT 漏条件」这类漂移测不出来 */
function mockCandidateQuery(rows: unknown[] = [], count = rows.length): Captured {
  const captured: Captured = {}
  mockDb.select
    .mockReturnValueOnce({
      from: () => ({
        leftJoin: () => ({
          leftJoin: () => ({
            where: async (cond: unknown) => {
              captured.countWhere = cond
              return [{ count }]
            },
          }),
        }),
      }),
    })
    .mockReturnValueOnce({
      from: () => ({
        leftJoin: () => ({
          leftJoin: () => ({
            where: (cond: unknown) => {
              captured.listWhere = cond
              return {
                orderBy: (...order: unknown[]) => {
                  captured.orderBy = order
                  return {
                    limit: (limit: number) => {
                      captured.limit = limit
                      return {
                        offset: async (offset: number) => {
                          captured.offset = offset
                          return rows
                        },
                      }
                    },
                  }
                },
              }
            },
          }),
        }),
      }),
    })
  return captured
}

async function whereOf(filters: Parameters<typeof listInventoryDocCandidates>[0]) {
  const captured = mockCandidateQuery()
  await listInventoryDocCandidates(filters)
  const list = compile(captured.listWhere)
  const count = compile(captured.countWhere)
  expect(count.text, 'COUNT 与 LIST 的过滤条件必须一致').toBe(list.text)
  expect(count.params, 'COUNT 与 LIST 的绑定参数必须一致').toEqual(list.params)
  return { ...list, captured }
}

beforeEach(() => {
  vi.clearAllMocks()
  mockDb.select.mockReset()
  mockDb.execute.mockReset()
  vi.mocked(hasPermission).mockReturnValue(true)
  vi.mocked(isAdminScope).mockReturnValue(false)
  mockGetSession.mockResolvedValue(marketSession(['MKT-A', 'NODE-A1']))
  // syncInventoryLocations 短路：探测无漂移
  mockDb.execute.mockResolvedValue([{ drifted: false }] as never)
})

describe('候选用途白名单（#338）', () => {
  it('未知用途与原型链键一律拒绝，且不发查询', async () => {
    for (const purpose of ['nope', 'constructor', '__proto__', 'toString', undefined, 1]) {
      expect(resolveInventoryDocCandidate(purpose)).toBeNull()
      await expect(listInventoryDocCandidates({ purpose } as never)).rejects.toThrow(/^INVALID_PARAMS/)
    }
    expect(mockDb.select).not.toHaveBeenCalled()
  })

  it('状态类候选与办理台 inbox 同一口径（类型 / 状态 / 方向逐条相等）', () => {
    const pairs = [
      ['market-receipt', 'market-receipt'],
      ['store-receipt', 'store-receipt'],
      ['supply-chain-receipt', 'supply-chain-receipt'],
      ['supply-chain-purchase-cancel', 'supply-chain-purchase-cancel'],
      ['shipment-cancel-approval', 'shipment-cancel-approval'],
      ['store-return-approval', 'store-return-approval'],
      ['market-return-approval', 'market-return-approval'],
    ] as const
    for (const [purpose, operation] of pairs) {
      const candidate = INVENTORY_DOC_CANDIDATES[purpose]
      const inbox = INVENTORY_OPERATION_DOC_QUERY[operation].inbox!
      expect(candidate.rules.map((rule) => rule.docType), purpose).toEqual([...inbox.docTypes])
      expect(candidate.rules.flatMap((rule) => rule.statuses ?? []), purpose).toEqual([...(inbox.statuses ?? [])])
      expect(candidate.scopeRole, purpose).toBe(inbox.scopeRole)
      expect(Boolean(candidate.cancellationRequested), purpose).toBe(Boolean(inbox.cancellationRequested))
      expect(Boolean(candidate.requireRemaining), purpose).toBe(Boolean(inbox.pendingItemScope))
    }
  })

  it('只有三类建单来源能切换「显示全部」', () => {
    const toggles = INVENTORY_DOC_CANDIDATE_PURPOSES.filter((purpose) => INVENTORY_DOC_CANDIDATES[purpose].remainingToggle)
    expect(toggles).toEqual(['purchase-order-source', 'company-shipment-source', 'store-allocation-source'])
  })
})

describe('候选查询的 scope（越权查不到）', () => {
  it('市场会话：双端可见 + 动作端（target）单端收窄，其它市场节点绝不出现', async () => {
    const { text, params } = await whereOf({ purpose: 'store-allocation-source' })
    expect(text).toMatch(/"source_org_node_id" in \(\$\d+, \$\d+\) or "inventory_docs"\."target_org_node_id" in/)
    // 单端收窄：target in scope 单独再出现一次
    expect(text.match(/"target_org_node_id" in/g)?.length).toBe(2)
    expect(params).toContain('MKT-A')
    expect(params).not.toContain('MKT-B')
  })

  it('撤回审批按 source 收窄（全表唯一的 source）', async () => {
    const { text } = await whereOf({ purpose: 'shipment-cancel-approval' })
    expect(text.match(/"source_org_node_id" in/g)?.length).toBe(2)
    expect(text.match(/"target_org_node_id" in/g)?.length).toBe(1)
    expect(text).toContain('"cancellation_request_reason" is not null')
  })

  it('scope 为空集 fail-closed', async () => {
    mockGetSession.mockResolvedValue({
      employeeId: 'E-NONE', name: '无绑定', phone: '13800000000', roles: [],
      permissions: { actions: ['inventory:list'], scopeStoreIds: [], scopeOrgNodeIds: [] },
    } as never)
    const { text } = await whereOf({ purpose: 'market-receipt' })
    expect(text).toBe('FALSE')
  })

  it('admin 不受 scope 限制，但类型 / 状态条件照样生效', async () => {
    vi.mocked(isAdminScope).mockReturnValue(true)
    const { text, params } = await whereOf({ purpose: 'market-receipt' })
    expect(text).not.toContain('org_node_id" in')
    expect(params).toEqual(expect.arrayContaining(['品项公司发货', '待收货']))
  })
})

describe('候选查询的类型 / 状态 / 剩余量口径', () => {
  it('采购来源：汇总单排已取消，需求单只要已完成；默认只列有未下单量的', async () => {
    const { text, params } = await whereOf({ purpose: 'purchase-order-source' })
    expect(text).toMatch(/"doc_type" = \$\d+ and "inventory_docs"\."status" <> \$\d+\) or \("inventory_docs"\."doc_type" = \$\d+ and "inventory_docs"\."status" in \(\$\d+\)/)
    expect(params).toEqual(expect.arrayContaining(['市场报货汇总', '已取消', '品项公司报货需求', '已完成']))
    expect(text).toContain('EXISTS')
    expect(text).toContain('COALESCE(cand_item.fulfilled_quantity, 0) < cand_item.quantity')
  })

  it('发货来源：未发量看「采购订单发货」血缘（排已取消目标单），只算有市场归属的行', async () => {
    const { text, params } = await whereOf({ purpose: 'company-shipment-source' })
    expect(text).toContain('cand_item.market_id IS NOT NULL')
    expect(text).toContain('cand_link.from_item_id = cand_item.id')
    expect(text).toContain("cand_link_doc.status <> '已取消'")
    expect(params).toContain('采购订单发货')
  })

  it('配货来源：未配量看「门店报货配货」血缘', async () => {
    const { text, params } = await whereOf({ purpose: 'store-allocation-source' })
    expect(text).not.toContain('cand_item.market_id IS NOT NULL')
    expect(params).toContain('门店报货配货')
    expect(params).toContain('门店报货')
  })

  it('建单来源选「显示全部」后去掉剩余量条件，但仍排除已取消', async () => {
    const { text, params } = await whereOf({ purpose: 'store-allocation-source', includeExhausted: true })
    expect(text).not.toContain('EXISTS')
    expect(params).toContain('已取消')
  })

  it('供应链采购入库恒要求有未入库行，includeExhausted 不放宽它', async () => {
    const { text } = await whereOf({ purpose: 'supply-chain-receipt', includeExhausted: true })
    expect(text).toContain('EXISTS')
  })

  it('撤回申请排除已有实收的发货单（守卫：任一行 fulfilled > 0 即 CONFLICT）', async () => {
    const { text } = await whereOf({ purpose: 'shipment-cancel-request' })
    expect(text).toContain('NOT EXISTS')
    expect(text).toContain('COALESCE(cand_received.fulfilled_quantity, 0) > 0')
    // 收货候选不受此限（部分收货的单还要继续收）
    const receipt = await whereOf({ purpose: 'market-receipt' })
    expect(receipt.text).not.toContain('cand_received')
  })

  it('发货来源「显示全部」仍要求至少一条市场行（纯自用采购单无行可发）', async () => {
    const { text } = await whereOf({ purpose: 'company-shipment-source', includeExhausted: true })
    expect(text).toContain('cand_item.market_id IS NOT NULL')
    expect(text).not.toContain('cand_link')
  })

  it('状态类候选不加剩余量条件（关闭采购作用于整单）', async () => {
    const { text } = await whereOf({ purpose: 'supply-chain-purchase-cancel' })
    expect(text).not.toContain('EXISTS')
  })
})

describe('候选查询的检索与分页', () => {
  it('关键字检索单号与两端主体名，% _ \\ 都转义', async () => {
    const { text, params } = await whereOf({ purpose: 'market-receipt', keyword: ' 5%_a\\ ' })
    expect(text).toMatch(/"inventory_docs"\."id" ilike \$\d+ or "source_loc"\."name" ilike \$\d+ or "target_loc"\."name" ilike \$\d+/)
    expect(params).toContain('%5\\%\\_a\\\\%')
  })

  it('日期区间按单据日期闭区间；格式不对直接拒', async () => {
    const { text, params } = await whereOf({ purpose: 'market-receipt', startDate: '2026-09-01', endDate: '2026-09-15' })
    expect(text).toMatch(/"doc_date" >= \$\d+/)
    expect(text).toMatch(/"doc_date" <= \$\d+/)
    expect(params).toEqual(expect.arrayContaining(['2026-09-01', '2026-09-15']))
    for (const bad of ['2026/09/01', '2026-13-45', '2026-02-30', "2026-09-01' OR 1=1"]) {
      await expect(listInventoryDocCandidates({ purpose: 'market-receipt', startDate: bad })).rejects.toThrow(/^INVALID_PARAMS/)
    }
  })

  it('入参类型不对 / 开始晚于结束 → INVALID_PARAMS，而不是 TypeError 变 500', async () => {
    for (const filters of [
      { purpose: 'market-receipt', keyword: 123 },
      { purpose: 'market-receipt', startDate: ['2026-09-01'] },
      { purpose: 'market-receipt', targetOrgNodeId: { a: 1 } },
      { purpose: 'market-receipt', startDate: '2026-09-10', endDate: '2026-09-01' },
      { purpose: 'store-allocation-source', includeExhausted: 'true' },
    ]) {
      await expect(listInventoryDocCandidates(filters as never)).rejects.toThrow(/^INVALID_PARAMS/)
    }
    expect(mockDb.select).not.toHaveBeenCalled()
  })

  it('入参校验先于 scope 判定：空 scope 会话传非法入参同样 INVALID_PARAMS，不是空结果', async () => {
    mockGetSession.mockResolvedValue({
      employeeId: 'E-NONE', name: '无绑定', phone: '13800000000', roles: [],
      permissions: { actions: ['inventory:list'], scopeStoreIds: [], scopeOrgNodeIds: [] },
    } as never)
    await expect(listInventoryDocCandidates({ purpose: 'market-receipt', keyword: 123 } as never)).rejects.toThrow(/^INVALID_PARAMS/)
    await expect(listInventoryDocCandidateIds({ purpose: 'purchase-order-source', startDate: '2026-02-30' })).rejects.toThrow(/^INVALID_PARAMS/)
    // 入参校验先于 syncInventoryLocations：不碰库
    expect(mockDb.execute).not.toHaveBeenCalled()
  })

  it('接收端收窄参数生效', async () => {
    const { text, params } = await whereOf({ purpose: 'purchase-order-source', targetOrgNodeId: 'HQ-1' })
    expect(text).toMatch(/"target_org_node_id" = \$\d+/)
    expect(params).toContain('HQ-1')
  })

  it('发起端收窄参数生效（#337 分院配货选了收货门店后只列该门店的报货单）；类型不对按参数错误', async () => {
    const { text, params } = await whereOf({ purpose: 'store-allocation-source', sourceOrgNodeId: 'ORG-S1', targetOrgNodeId: 'MKT-A' })
    expect(text).toMatch(/"source_org_node_id" = \$\d+/)
    expect(text).toMatch(/"target_org_node_id" = \$\d+/)
    expect(params).toEqual(expect.arrayContaining(['ORG-S1', 'MKT-A']))
    await expect(listInventoryDocCandidates({ purpose: 'store-allocation-source', sourceOrgNodeId: 42 } as never))
      .rejects.toThrow(/^INVALID_PARAMS/)
  })

  it('排序末位是 id（翻页不重不漏），页长夹白名单、offset 按页算', async () => {
    const captured = mockCandidateQuery([], 0)
    const result = await listInventoryDocCandidates({ purpose: 'market-receipt', page: 3, pageSize: 30 })
    const order = (captured.orderBy ?? []).map((part) => compile(part).text)
    expect(order).toEqual([
      '"inventory_docs"."doc_date" desc',
      '"inventory_docs"."created_at" desc',
      '"inventory_docs"."id" desc',
    ])
    // 30 不在白名单 → 20；第 3 页 offset 40
    expect(captured.limit).toBe(20)
    expect(captured.offset).toBe(40)
    expect(result.pageSize).toBe(20)
  })

  it('返回行带进度、不带金额', async () => {
    const now = new Date('2026-09-25T00:00:00Z')
    mockCandidateQuery([{
      doc: {
        id: 'MBH-1', docType: '门店报货', status: '已完成', sourceOrgNodeId: 'NODE-A1', targetOrgNodeId: 'MKT-A',
        marketId: 'MKT-A', supplierId: null, docDate: '2026-09-01', relatedSaleOrderId: null, customerName: null,
        employeeName: null, supplierName: null, externalPartyName: null, logisticsCompany: null, trackingNo: null,
        receiptAttachmentUrl: null, totalQuantity: '5', totalAmount: '500.00', remark: null, auditRemark: null,
        createdBy: 'E1', confirmedAt: null, approvedAt: null, rejectedAt: null, cancellationRequestReason: null,
        cancellationRequestedBy: null, cancellationRequestedAt: null, cancellationReason: null, cancelledAt: null,
        createdAt: now, updatedAt: now,
      },
      sourceOrgNodeName: '门店甲', sourceOrgNodeType: '门店', targetOrgNodeName: '市场A', targetOrgNodeType: '市场',
      partiallyReceived: false, progressTotal: '5.00', progressDone: '2.00',
    }], 1)
    const result = await listInventoryDocCandidates({ purpose: 'store-allocation-source' })
    expect(result.total).toBe(1)
    expect(result.data[0]).toMatchObject({
      id: 'MBH-1', sourceOrgNodeName: '门店甲', targetOrgNodeName: '市场A', progress: { done: 2, total: 5 },
    })
    expect(result.data[0].totalAmount).toBeUndefined()
  })
})

describe('一键带出（listInventoryDocCandidateIds）', () => {
  function mockIdsQuery(ids: string[]) {
    const captured: { where?: unknown; limit?: number } = {}
    mockDb.select.mockReturnValueOnce({
      from: () => ({
        leftJoin: () => ({
          leftJoin: () => ({
            where: (cond: unknown) => {
              captured.where = cond
              return {
                orderBy: () => ({
                  limit: async (limit: number) => {
                    captured.limit = limit
                    return ids.map((id) => ({ id }))
                  },
                }),
              }
            },
          }),
        }),
      }),
    })
    return captured
  }

  it('恒只取有剩余量的单，按日期区间，多取一条用来判断超限', async () => {
    const captured = mockIdsQuery(['HZ-1', 'XQ-2'])
    const result = await listInventoryDocCandidateIds({
      purpose: 'purchase-order-source', startDate: '2026-09-01', endDate: '2026-09-05',
    })
    expect(result.ids).toEqual(['HZ-1', 'XQ-2'])
    const { text, params } = compile(captured.where)
    expect(text).toContain('EXISTS')
    expect(params).toEqual(expect.arrayContaining(['2026-09-01', '2026-09-05']))
    expect(captured.limit).toBe(INVENTORY_DOC_CANDIDATE_BULK_LIMIT + 1)
  })

  it('超过上限报错而不是静默截断（截断等于少采购）', async () => {
    mockIdsQuery(Array.from({ length: INVENTORY_DOC_CANDIDATE_BULK_LIMIT + 1 }, (_, index) => `HZ-${index}`))
    await expect(listInventoryDocCandidateIds({ purpose: 'purchase-order-source' })).rejects.toThrow(/^INVALID_PARAMS: .*缩小日期区间/)
  })

  it('未知用途、以及没有「剩余量」语义的状态类用途都拒绝', async () => {
    for (const purpose of ['constructor', 'market-receipt', 'shipment-cancel-approval']) {
      await expect(listInventoryDocCandidateIds({ purpose } as never)).rejects.toThrow(/^INVALID_PARAMS/)
    }
    expect(mockDb.select).not.toHaveBeenCalled()
  })
})

describe('批量取详情（getInventoryCoreDocsByIds）', () => {
  it('入参必须是字符串数组，且不超过带出上限', async () => {
    for (const bad of [null, 'CGD-1', [1], [{}]]) {
      await expect(getInventoryCoreDocsByIds(bad as never)).rejects.toThrow(/^INVALID_PARAMS/)
    }
    const tooMany = Array.from({ length: INVENTORY_DOC_CANDIDATE_BULK_LIMIT + 1 }, (_, index) => `HZ-${index}`)
    await expect(getInventoryCoreDocsByIds(tooMany)).rejects.toThrow(/^INVALID_PARAMS/)
    expect(mockDb.select).not.toHaveBeenCalled()
  })

  it('空数组直接返回空，不查库', async () => {
    await expect(getInventoryCoreDocsByIds([])).resolves.toEqual([])
    expect(mockDb.select).not.toHaveBeenCalled()
  })
})

describe('门店未配报货 SKU（#337 拍板 A 的提示数据）', () => {
  it('与 store-allocation-source 候选同一套条件（scope / 类型 / 已取消排除 / 门店收窄），行级未配量与建单守卫同口径', async () => {
    mockDb.execute
      .mockResolvedValueOnce([{ drifted: false }] as never)
      .mockResolvedValueOnce([{ sku_id: 'SKU-1', remaining_quantity: '3.00', doc_ids: ['DBH-1', 'DBH-2'] }] as never)
    const result = await listStoreUnallocatedRequestSkus({ storeOrgNodeId: 'ORG-S1', marketId: 'MKT-A' })
    expect(result).toEqual([{ skuId: 'SKU-1', remainingQuantity: 3, docIds: ['DBH-1', 'DBH-2'] }])
    const query = compile(mockDb.execute.mock.calls[1][0])
    // 与候选选择器同样按配货市场（报货单接收端）收窄
    expect(query.text).toMatch(/"inventory_docs"\."target_org_node_id" = \$\d+/)
    // scope：两端 OR + 动作端（报货单的接收市场）收窄
    expect(query.text).toMatch(/"inventory_docs"\."target_org_node_id" in \(\$\d+, \$\d+\)/)
    expect(query.text).toMatch(/"inventory_docs"\."source_org_node_id" = \$\d+/)
    expect(query.text).toMatch(/"inventory_docs"\."status" <> \$\d+/)
    // 已配量只数「门店报货配货」且目标单未取消 —— 自选行不写血缘，天然不计入
    expect(query.text).toContain('cand_link.relation_type = $')
    expect(query.text).toContain("cand_link_doc.status <> '已取消'")
    expect(query.params).toEqual(expect.arrayContaining(['门店报货', '已取消', 'ORG-S1', '门店报货配货', 'MKT-A', 'NODE-A1']))
  })

  it('越权空 scope 恒为空条件；缺门店 / 类型不对按参数错误且不碰库', async () => {
    await expect(listStoreUnallocatedRequestSkus({ storeOrgNodeId: '', marketId: 'MKT-A' })).rejects.toThrow(/^INVALID_PARAMS/)
    await expect(listStoreUnallocatedRequestSkus({ storeOrgNodeId: 7, marketId: 'MKT-A' } as never)).rejects.toThrow(/^INVALID_PARAMS/)
    // 配货市场必填：不收窄市场时提示会混入本市场引用不了的旧市场报货单
    await expect(listStoreUnallocatedRequestSkus({ storeOrgNodeId: 'ORG-S1' } as never)).rejects.toThrow(/^INVALID_PARAMS/)
    expect(mockDb.execute).not.toHaveBeenCalled()

    mockGetSession.mockResolvedValue({
      employeeId: 'E-NONE', name: '无绑定', phone: '13800000000', roles: [],
      permissions: { actions: ['inventory:list'], scopeStoreIds: [], scopeOrgNodeIds: [] },
    } as never)
    mockDb.execute
      .mockResolvedValueOnce([{ drifted: false }] as never)
      .mockResolvedValueOnce([] as never)
    await listStoreUnallocatedRequestSkus({ storeOrgNodeId: 'ORG-S1', marketId: 'MKT-A' })
    expect(compile(mockDb.execute.mock.calls[1][0]).text).toMatch(/WHERE\s+false/i)
  })
})
