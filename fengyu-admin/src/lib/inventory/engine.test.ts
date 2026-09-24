import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
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
  isAdminScope: vi.fn(() => true),
  requireAnyPermission: vi.fn(),
  requirePermission: vi.fn(),
}))
vi.mock('@/lib/operation-log', () => ({ logOperation: vi.fn() }))
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }))

import {
  approveInventoryCoreDoc,
  confirmInventoryCoreReceive,
  createInventoryCoreDoc,
  createInventoryPromotionPlan,
  createInventorySku,
  createInventorySupplier,
  disableInventoryPromotionPlan,
  getInventoryCoreDocById,
  listInventoryCoreDocs,
  listInventoryLocationFilterOptions,
  listInventoryLots,
  listInventorySkus,
  listInventoryMarketTransferTargets,
  listInventorySuppliers,
  inventorySkuOptionConditions,
  rejectInventoryCoreDoc,
  syncInventoryLocations,
  updateInventorySku,
  updateInventorySupplier,
  updateInventoryPromotionPlan,
} from './engine'
import { hasPermission, isAdminScope } from '@/lib/permissions'
import { INVENTORY_GENERIC_DOC_TYPES } from './types'

/*
 * 每个用例从干净的默认权限开始。
 *
 * `vi.clearAllMocks()` 只清调用记录、**不恢复实现** —— 有几个用例用
 * `vi.mocked(hasPermission).mockReturnValue(false)` 测拒绝路径，那份实现会一路泄漏到
 * 后面所有 describe。以前没炸是因为建单路径根本不调 hasPermission；#191 给通用建单
 * 补了层级 action 校验之后，泄漏立刻变成「后续建单用例全部 PERMISSION_DENIED」。
 * 各 describe 自己的 beforeEach 仍可覆盖（内层后跑）。
 */
beforeEach(() => {
  vi.mocked(hasPermission).mockReturnValue(true)
})

const SESSION = {
  employeeId: 'E001',
  name: '测试用户',
  phone: '13800000000',
  roles: [{ role: 'admin', scopeId: 'HQ', scopeType: '总部' }],
  permissions: { actions: ['inventory:create_doc', 'inventory:approve'], scopeStoreIds: [] },
} as never

/**
 * `.limit(1)` 之后**必须**再接 `.for('share')` 的查询（resolveSkuSupplier 对供应商行加行锁）
 * 用这个。它记录锁强度，让测试能断言到底加没加锁、加的是哪一种 ——
 * 只做成「既可 await 又有个忽略参数的 .for()」的话，把生产代码里的 `.for('share')` 删掉、
 * 或降级成 `.for('key share')`，测试照样全绿（FOR KEY SHARE 挡不住改名这种非键列 UPDATE）。
 */
function selectWithLock(rows: unknown[], lock: { strength?: string }) {
  return {
    from: () => ({
      where: () => ({
        limit: () => ({
          for: async (strength: string) => {
            lock.strength = strength
            return rows
          },
        }),
      }),
    }),
  }
}

function selectWithLimit(rows: unknown[]) {
  return {
    from: () => ({
      where: () => ({
        limit: async () => rows,
      }),
    }),
  }
}

function selectWithoutLimit(rows: unknown[]) {
  return {
    from: () => ({
      where: async () => rows,
    }),
  }
}

function selectWithOrder(rows: unknown[]) {
  return {
    from: () => ({
      where: () => ({
        orderBy: async () => rows,
      }),
    }),
  }
}

function detailHeadSelect(rows: unknown[]) {
  return {
    from: () => ({
      leftJoin: () => ({
        leftJoin: () => ({
          where: () => ({
            limit: async () => rows,
          }),
        }),
      }),
    }),
  }
}

function detailItemsSelect(rows: unknown[]) {
  return {
    from: () => ({
      where: () => ({
        orderBy: async () => rows,
      }),
    }),
  }
}

function promotionPlanSelect(rows: unknown[]) {
  return {
    from: () => ({
      leftJoin: () => ({
        where: () => ({
          orderBy: async () => rows,
        }),
      }),
    }),
  }
}

function promotionItemSelect(rows: unknown[]) {
  return {
    from: () => ({
      innerJoin: () => ({
        where: () => ({
          orderBy: async () => rows,
        }),
      }),
    }),
  }
}

function renderSql(query: unknown): string {
  const chunks = (query as { queryChunks?: Array<{ value?: unknown }> }).queryChunks ?? []
  return chunks
    .map((chunk) => {
      if (!chunk) return ''
      return Array.isArray(chunk.value) ? chunk.value.join('') : String(chunk)
    })
    .join('')
}

function sqlContains(query: unknown, fragment: string): boolean {
  const seen = new Set<object>()
  const visit = (value: unknown): boolean => {
    if (typeof value === 'string') return value.includes(fragment)
    if (!value || typeof value !== 'object') return false
    if (seen.has(value)) return false
    seen.add(value)
    if (Array.isArray(value)) return value.some(visit)
    return Object.values(value as Record<string, unknown>).some(visit)
  }
  return visit(query)
}

function initializedCutoverExecutor(txExecute: (query: unknown) => Promise<unknown>) {
  return async (query: unknown) => {
    const rendered = renderSql(query)
    if (rendered.includes('inventory_cutover_states')) {
      return rendered.includes('SELECT status') ? [{ status: '已初始化' }] : []
    }
    return txExecute(query)
  }
}

function lotRow(quantityOnHand = '10') {
  return {
    id: 1,
    location_id: 'HQ',
    sku_id: 'SKU-1',
    sku_name: '测试 SKU',
    spec_name: null,
    supplier: null,
    product_series: null,
    batch_no: null,
    expiry_date: null,
    is_gift: false,
    quantity_on_hand: quantityOnHand,
    supply_chain_unit_cost: null,
    market_standard_unit_price: null,
    market_unit_discount: null,
    market_actual_unit_price: null,
    store_standard_unit_price: null,
    store_unit_discount: null,
    store_actual_unit_price: null,
  }
}

describe('库存通用建单边界', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(isAdminScope).mockReturnValue(true)
    mockGetSession.mockResolvedValue(SESSION)
    mockDb.execute.mockResolvedValue([])
    mockDb.select.mockReset()
    mockDb.select.mockImplementation(() => selectWithLimit([{ locationType: '总部' }]))
    mockDb.transaction.mockReset()
  })

  it('拒绝手工创建调货入库和期初库存', async () => {
    for (const docType of ['分院调货入库', '市场间调货入库', '期初库存'] as const) {
      await expect(createInventoryCoreDoc({ docType, items: [] } as never))
        .rejects.toThrow('只能由收货确认或期初迁移流程生成')
    }
  })

  it('拒绝从通用入口创建需要专用流程的单据', async () => {
    await expect(createInventoryCoreDoc({ docType: '市场采购入库', items: [] } as never))
      .rejects.toThrow('必须从对应的专用业务流程创建')
  })

  it('期初库存未核验完成时禁止写入库存业务', async () => {
    const txExecute = vi.fn()
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{ status: '待核验' }])
    mockDb.transaction.mockImplementationOnce(async (callback: (tx: unknown) => unknown) => callback({
      execute: txExecute,
    }))

    await expect(approveInventoryCoreDoc('MBS-260809-0001'))
      .rejects.toThrow('库存期初尚未导入并核验完成')
    expect(txExecute).toHaveBeenCalledTimes(2)
  })

  it('专用单据不能经通用审批、驳回或收货入口绕过业务状态机', async () => {
    mockDb.transaction.mockImplementationOnce(async (callback: (tx: unknown) => unknown) => callback({
      execute: initializedCutoverExecutor(vi.fn().mockResolvedValueOnce([{
        id: 'YTH-260809-0001', doc_type: '院退货', status: '待审批', source_org_node_id: 'STORE-1',
      }])),
    }))
    await expect(approveInventoryCoreDoc('YTH-260809-0001'))
      .rejects.toThrow('必须通过对应的专用业务流程处理')

    mockDb.transaction.mockImplementationOnce(async (callback: (tx: unknown) => unknown) => callback({
      execute: initializedCutoverExecutor(vi.fn().mockResolvedValueOnce([{
        doc_type: '市场退货', status: '待审批', source_org_node_id: 'MARKET-1', target_org_node_id: 'HQ',
      }])),
    }))
    await expect(rejectInventoryCoreDoc('MTH-260809-0001'))
      .rejects.toThrow('必须通过对应的专用业务流程处理')

    mockDb.transaction.mockImplementationOnce(async (callback: (tx: unknown) => unknown) => callback({
      execute: initializedCutoverExecutor(vi.fn().mockResolvedValueOnce([{
        id: 'FPH-260809-0001', doc_type: '分院配货', status: '待收货',
        source_org_node_id: 'MARKET-1', target_org_node_id: 'STORE-1',
        total_quantity: '1', remark: null,
      }])),
    }))
    await expect(confirmInventoryCoreReceive('FPH-260809-0001'))
      .rejects.toThrow('必须通过对应的专用业务流程处理')
  })

  it('分院调货的两端必须均为门店', async () => {
    mockDb.select
      .mockReturnValueOnce(selectWithLimit([{ locationType: '门店' }]))
      .mockReturnValueOnce(selectWithLimit([{ locationType: '门店' }]))
      .mockReturnValueOnce(selectWithoutLimit([
        { locationId: 'market-A', orgNodeId: 'market-A', locationType: '市场', parentLocationId: 'HQ' },
        { locationId: 'store-A', orgNodeId: 'store-A', locationType: '门店', parentLocationId: 'market-A' },
      ]))

    await expect(createInventoryCoreDoc({
      docType: '分院调货出库',
      sourceOrgNodeId: 'market-A',
      targetOrgNodeId: 'store-A',
      items: [{ skuId: 'SKU-1', quantity: 1 }],
    } as never)).rejects.toThrow('出入库主体必须均为门店')
  })

  it('分院调货的门店必须属于同一市场', async () => {
    mockDb.select
      .mockReturnValueOnce(selectWithLimit([{ locationType: '门店' }]))
      .mockReturnValueOnce(selectWithLimit([{ locationType: '门店' }]))
      .mockReturnValueOnce(selectWithoutLimit([
        { locationId: 'store-A', orgNodeId: 'store-A', locationType: '门店', parentLocationId: 'market-A' },
        { locationId: 'store-B', orgNodeId: 'store-B', locationType: '门店', parentLocationId: 'market-B' },
      ]))

    await expect(createInventoryCoreDoc({
      docType: '分院调货出库',
      sourceOrgNodeId: 'store-A',
      targetOrgNodeId: 'store-B',
      items: [{ skuId: 'SKU-1', quantity: 1 }],
    } as never)).rejects.toThrow('同市场内部的门店才可调货')
  })

  it('市场间调货的两端必须均为市场', async () => {
    mockDb.select
      .mockReturnValueOnce(selectWithLimit([{ locationType: '市场' }]))
      .mockReturnValueOnce(selectWithLimit([{ locationType: '市场' }]))
      .mockReturnValueOnce(selectWithoutLimit([
        { locationId: 'market-A', orgNodeId: 'market-A', locationType: '市场', parentLocationId: 'HQ' },
        { locationId: 'store-A', orgNodeId: 'store-A', locationType: '门店', parentLocationId: 'market-A' },
      ]))

    await expect(createInventoryCoreDoc({
      docType: '市场间调货出库',
      sourceOrgNodeId: 'market-A',
      targetOrgNodeId: 'store-A',
      items: [{ skuId: 'SKU-1', quantity: 1 }],
    } as never)).rejects.toThrow('出入库主体必须均为市场')
  })

  it('供应链采购入库不能经通用入口绕过专用采购收货流程', async () => {
    await expect(createInventoryCoreDoc({
      docType: '供应链采购入库',
      targetOrgNodeId: 'market-A',
      items: [{ skuId: 'SKU-1', quantity: 1 }],
    } as never)).rejects.toThrow('必须从对应的专用业务流程创建')
  })

  it('通用入库不能写入其他市场的自采 SKU', async () => {
    const txExecute = vi.fn()
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{
        sku_id: 'SELF-SKU',
        product_name: '市场 A 自采产品',
        spec_name: null,
        supplier: null,
        product_series: null,
        source_type: '市场自采',
        owner_market_id: 'MARKET-A',
        supply_chain_purchase_price: null,
        market_purchase_price: null,
        store_purchase_price: null,
      }])
      .mockResolvedValueOnce([{
        location_id: 'MARKET-B',
        location_type: '市场',
        parent_location_id: 'HQ',
      }])
    mockDb.transaction.mockImplementation(async (callback: (tx: unknown) => unknown) => callback({
      execute: initializedCutoverExecutor(txExecute),
      insert: vi.fn(() => ({ values: vi.fn().mockResolvedValue(undefined) })),
    }))
    mockDb.select.mockImplementation(() => selectWithLimit([{ locationType: '市场' }]))

    await expect(createInventoryCoreDoc({
      docType: '市场产品盘溢',
      targetOrgNodeId: 'MARKET-B',
      items: [{ skuId: 'SELF-SKU', quantity: 1 }],
    } as never)).rejects.toThrow('仅可在归属市场使用')
  })

  it.each([
    ['内部领用', 'sourceOrgNodeId', '市场', '内部领用出库主体必须是总部'],
    ['院顾客退货', 'targetOrgNodeId', '市场', '院顾客退货入库主体必须是门店'],
    ['市场产品报损', 'sourceOrgNodeId', '门店', '市场产品报损出库主体必须是市场'],
    ['院产品报损', 'sourceOrgNodeId', '市场', '院产品报损出库主体必须是门店'],
    ['市场产品盘溢', 'targetOrgNodeId', '门店', '市场产品盘溢入库主体必须是市场'],
    ['市场库存盘点', 'sourceOrgNodeId', '门店', '市场库存盘点主体必须是市场'],
    ['分院库存盘点', 'sourceOrgNodeId', '市场', '分院库存盘点主体必须是门店'],
  ] as const)('%s 限制库存主体类型', async (docType, locationField, actualType, expectedMessage) => {
    mockDb.select.mockImplementation(() => selectWithLimit([{ locationType: actualType }]))
    const input: Record<string, unknown> = {
      docType,
      items: [{ skuId: 'SKU-1', quantity: 1 }],
      [locationField]: 'LOCATION-1',
    }

    await expect(createInventoryCoreDoc(input as never)).rejects.toThrow(expectedMessage)
  })

  it('院顾客产品出库不能走通用建单：只能由提货服务产生（#350）', async () => {
    mockDb.select.mockImplementation(() => selectWithLimit([{ locationType: '门店' }]))
    await expect(createInventoryCoreDoc({
      docType: '院顾客产品出库',
      sourceOrgNodeId: 'LOCATION-1',
      items: [{ skuId: 'SKU-1', quantity: 1 }],
    } as never)).rejects.toThrow('INVALID_STATE: 该库存单据必须从对应的专用业务流程创建')
    // 拒绝发生在任何库存写入之前
    expect(mockDb.transaction).not.toHaveBeenCalled()
  })

  it('分院库存盘点按组织节点 id 校验主体，不误用门店行的 location_id', async () => {
    // 门店库存行的 location_id=store_id 与 org_node_id 不同值；盘点校验必须按 org_node_id 命中，
    // 否则门店行必抛 NOT_FOUND（修复回归守卫）。
    const LOCATION_ROWS = [{ locationId: 'STORE-S1', orgNodeId: 'ORG-S1', locationType: '门店', parentLocationId: 'MARKET-1', isActive: true }]
    mockDb.select.mockImplementation(() => ({
      from: () => ({
        where: (condition: unknown) => ({
          limit: async () => (sqlContains(condition, 'org_node_id') && sqlContains(condition, 'ORG-S1') ? LOCATION_ROWS : []),
        }),
      }),
    }) as never)
    vi.mocked(mockDb.execute).mockResolvedValueOnce([] as never)
    vi.mocked(mockDb.execute).mockResolvedValueOnce([] as never)
    mockDb.transaction.mockImplementationOnce(async (callback: (tx: unknown) => unknown) => callback({
      execute: vi.fn().mockRejectedValue(new Error('STOP-AFTER-VALIDATION')),
    } as never))

    const err = await createInventoryCoreDoc({
      docType: '分院库存盘点',
      sourceOrgNodeId: 'ORG-S1',
      items: [{ skuId: 'SKU-1', quantity: 1 }],
    } as never).then(() => null, (error: Error) => error)
    // 走到事务说明全部前置校验（含盘点主体校验）通过；回归时这里会是「分院库存盘点主体不存在」。
    expect(err?.message).toBe('STOP-AFTER-VALIDATION')
  })
})

/**
 * #200 建单的 scope 校验必须落在「本单真正被改动库存的主体」上。
 *
 * 改前取 `sourceOrgNodeId ?? targetOrgNodeId` 并只校验它：入库类单据的流水写在 target
 * 上（`movementPlan.locationRole === 'target'`），却拿 source 去鉴权 —— 同时传一个自己
 * 有权限的 source + 一个无权限的 target，就能往无权操作的主体里加库存。共享建单表单本来
 * 就把出库/入库两个下拉都渲染出来，普通表单操作即可构造，不需要伪造请求。
 */
describe('#200 建单 scope 按真正被改动的主体校验', () => {
  /** 门店账号：只对 ORG-S1 可见，对 ORG-S2 无权 */
  const STORE_SESSION = {
    employeeId: 'E002',
    name: '门店账号',
    phone: '13800000002',
    roles: [{ role: 'manager', scopeId: 'ORG-S1', scopeType: '门店', scopeOrgNodeIds: ['ORG-S1'] }],
    permissions: {
      actions: ['inventory:create_doc', 'inventory:store_operate'],
      scopeStoreIds: ['S1'],
      scopeOrgNodeIds: ['ORG-S1'],
    },
  } as never

  /**
   * scope 校验现在**先于** `ensureOrgNodeLocation`（#200：否则「不存在 / 已停用 / 无权」
   * 三种不同的错就成了探测无权节点状态的信道）。所以这个 mock 不再是走到鉴权的前提，
   * 而是让鉴权通过后的那些用例能继续往下跑到事务。
   */
  function locationRow(locationType: string) {
    return [{
      locationId: 'LOC-X',
      orgNodeId: 'ORG-X',
      locationType,
      parentLocationId: null,
      isActive: true,
    }]
  }

  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(isAdminScope).mockReturnValue(false)   // 非总部账号才有 scope 约束
    mockGetSession.mockResolvedValue(STORE_SESSION)
    mockDb.execute.mockResolvedValue([])
    mockDb.select.mockReset()
    mockDb.select.mockImplementation(() => selectWithLimit(locationRow('门店')))
    mockDb.transaction.mockReset()
    mockDb.transaction.mockImplementation(async () => {
      throw new Error('REACHED-TRANSACTION')   // 任何越权组合都不该走到事务
    })
  })

  it('入库类：target 无权限时必须拒，不得因为 source 有权限而放行', async () => {
    // 院顾客退货 = INBOUND，流水写在 target；这正是 issue 举的触发场景
    await expect(createInventoryCoreDoc({
      docType: '院顾客退货',
      targetOrgNodeId: 'ORG-S2',              // 无权限的另一门店
      items: [{ skuId: 'SKU-1', quantity: 1 }],
    } as never)).rejects.toThrow('无权操作该组织节点单据')
  })

  /**
   * 只断言错误文案锁不住**顺序**：把 `ensureOrgNodeLocation` 移回鉴权之前，mock 的查询
   * 照样成功、最终仍抛同一句「无权操作」，测试依旧全绿。而顺序正是这里的安全属性 ——
   * 那个函数对「不存在 / 已停用 / 正常」抛三种不同的错，放在鉴权前就是一个探测无权节点
   * 状态的信道，还会让无权者触发 `syncInventoryLocations()` 写操作。
   * 所以直接断言：被拒的请求一次 DB 都没碰。
   */
  it('越权请求在任何 DB 访问之前就被拒（锁住鉴权/单边规则先于 location 查询）', async () => {
    await expect(createInventoryCoreDoc({
      docType: '院顾客退货',
      targetOrgNodeId: 'ORG-S2',
      items: [{ skuId: 'SKU-1', quantity: 1 }],
    } as never)).rejects.toThrow('无权操作该组织节点单据')

    expect(mockDb.select).not.toHaveBeenCalled()
    expect(mockDb.execute).not.toHaveBeenCalled()
    expect(mockDb.transaction).not.toHaveBeenCalled()
  })

  it('多余主体的请求同样零 DB 访问（单边规则必须先于 location 查询）', async () => {
    await expect(createInventoryCoreDoc({
      docType: '院顾客退货',
      sourceOrgNodeId: 'ORG-S1',              // 有权限，但这类单据不接受出库主体
      targetOrgNodeId: 'ORG-S1',
      items: [{ skuId: 'SKU-1', quantity: 1 }],
    } as never)).rejects.toThrow('院顾客退货不接受出库主体')

    expect(mockDb.select).not.toHaveBeenCalled()
    expect(mockDb.execute).not.toHaveBeenCalled()
    expect(mockDb.transaction).not.toHaveBeenCalled()
  })

  /**
   * 这条是本 issue 的核心回归，断言**必须精确到 PERMISSION_DENIED 的文案**：
   *
   * 本单有两道防线 ——「鉴权落在 target」和「单边单据拒绝另一边」，它们都能拦住这个组合，
   * 但抛的错不同。若断言写成两者之一皆可（宽松正则），把 `actingOrgNodeId` 回退成
   * `source ?? target` 后测试**照样全绿**（会走第二道防线抛 INVALID_PARAMS），这条回归
   * 就白写了 —— 实测踩过。
   *
   * 精确到「无权操作该组织节点单据」才同时锁住两件事：鉴权对象是 target，
   * 且鉴权发生在主体规则校验之前。
   */
  it('入库类：同时传有权限的 source + 无权限的 target 时，先以 target 鉴权并拒绝', async () => {
    await expect(createInventoryCoreDoc({
      docType: '院顾客退货',
      sourceOrgNodeId: 'ORG-S1',              // 自己有权限
      targetOrgNodeId: 'ORG-S2',              // 货实际进这里，但无权限
      items: [{ skuId: 'SKU-1', quantity: 1 }],
    } as never)).rejects.toThrow('无权操作该组织节点单据')
  })

  it('入库类：target 有权限时放行（校验对象换成 target，不是拒绝一切）', async () => {
    await expect(createInventoryCoreDoc({
      docType: '院顾客退货',
      targetOrgNodeId: 'ORG-S1',
      items: [{ skuId: 'SKU-1', quantity: 1 }],
    } as never)).rejects.toThrow('REACHED-TRANSACTION')
  })

  it('出库类：source 无权限时必须拒', async () => {
    // #350 前用「院顾客产品出库」；它移出通用白名单后改用同为出库、按 source 鉴权的门店报损
    await expect(createInventoryCoreDoc({
      docType: '院产品报损',
      sourceOrgNodeId: 'ORG-S2',
      items: [{ skuId: 'SKU-1', quantity: 1 }],
    } as never)).rejects.toThrow('无权操作该组织节点单据')
  })

  it('单边单据传另一边的主体时拒绝，而不是静默忽略', async () => {
    // #350 后通用类型里已没有「只出不进」的单边类型（院顾客产品出库移出白名单），
    // 「…不接受入库主体」那一支由 locationRole 推导保留、当前不可达，只剩入库单边这一半可测。
    await expect(createInventoryCoreDoc({
      docType: '院顾客退货',
      sourceOrgNodeId: 'ORG-S1',
      targetOrgNodeId: 'ORG-S1',
      items: [{ skuId: 'SKU-1', quantity: 1 }],
    } as never)).rejects.toThrow('院顾客退货不接受出库主体')
  })

  it('同主体单据：source 与 target 都给且不一致时拒绝（改前静默取 source，吃掉用户选的 target）', async () => {
    mockDb.select.mockImplementation(() => selectWithLimit(locationRow('门店')))
    await expect(createInventoryCoreDoc({
      docType: '分院库存盘点',
      sourceOrgNodeId: 'ORG-S1',
      targetOrgNodeId: 'ORG-S2',
      items: [{ skuId: 'SKU-1', quantity: 1 }],
    } as never)).rejects.toThrow('出库主体与入库主体必须是同一个')
  })

  it('同主体单据：两边给同一个值时正常放行', async () => {
    await expect(createInventoryCoreDoc({
      docType: '分院库存盘点',
      sourceOrgNodeId: 'ORG-S1',
      targetOrgNodeId: 'ORG-S1',
      items: [{ skuId: 'SKU-1', quantity: 1 }],
    } as never)).rejects.toThrow('REACHED-TRANSACTION')
  })

  /**
   * reject 的显式 source 校验原先没有任何回归测试 —— 既有 reject 用例走的是专用单据，
   * 会在 `assertGenericDocTransition` 就提前退出，把代码恢复成 `source ?? target` 照样全绿。
   * 这里用**通用**待审批单据打到那两行。
   */
  /** 锁「reject 按 source 鉴权」这个不变量本身（改前改后都成立），防止将来被改成按 target */
  it('驳回：source 越权时拒绝', async () => {
    mockDb.transaction.mockImplementationOnce(async (callback: (tx: unknown) => unknown) => callback({
      execute: initializedCutoverExecutor(vi.fn().mockResolvedValueOnce([{
        doc_type: '院产品报损', status: '待审批',
        source_org_node_id: 'ORG-S2',        // 无权限
        target_org_node_id: 'ORG-S1',        // 有权限
      }])),
    }))
    await expect(rejectInventoryCoreDoc('SPH-260809-0001'))
      .rejects.toThrow('无权操作该组织节点单据')
  })

  it('驳回：通用待审批单据缺 source 时明确报错，而不是悄悄拿 target 顶上', async () => {
    mockDb.transaction.mockImplementationOnce(async (callback: (tx: unknown) => unknown) => callback({
      execute: initializedCutoverExecutor(vi.fn().mockResolvedValueOnce([{
        doc_type: '院产品报损', status: '待审批',
        source_org_node_id: null,
        target_org_node_id: 'ORG-S1',
      }])),
    }))
    await expect(rejectInventoryCoreDoc('SPH-260809-0002'))
      .rejects.toThrow('待审批单据缺少出库主体')
  })

  it('无流水单据（建单即待审批）沿用 source ?? target 口径，行为与改前一致', async () => {
    // 院产品报损建单落「待审批」→ movementPlan 为 null，此刻不动库存，
    // 真正扣减发生在审批那步（approveDoc 另有针对 source 的校验）
    await expect(createInventoryCoreDoc({
      docType: '院产品报损',
      sourceOrgNodeId: 'ORG-S2',
      items: [{ skuId: 'SKU-1', quantity: 1 }],
    } as never)).rejects.toThrow('无权操作该组织节点单据')

    await expect(createInventoryCoreDoc({
      docType: '院产品报损',
      sourceOrgNodeId: 'ORG-S1',
      items: [{ skuId: 'SKU-1', quantity: 1 }],
    } as never)).rejects.toThrow('REACHED-TRANSACTION')
  })
})

describe('库存 SKU 来源与价格保护', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(isAdminScope).mockReturnValue(true)
    mockGetSession.mockResolvedValue(SESSION)
    mockDb.select.mockReset()
    // updateInventorySku 现在整段跑在事务里（resolveSkuSupplier 要在同一事务内对档案行
    // 加 FOR SHARE）。默认把 mockDb 自身当 tx 传进去，tx.select / tx.update 就直接复用
    // 各测试已有的 mock；需要 execute/insert 的建单类测试再用 mockImplementationOnce 覆盖。
    mockDb.transaction.mockImplementation(async (callback: (tx: unknown) => unknown) => callback(mockDb))
  })

  it('库存商品编号按上海日期和当日序号由系统生成', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-08-13T04:00:00.000Z'))
    try {
      const values = vi.fn().mockResolvedValue(undefined)
      const txExecute = vi.fn()
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([{ value: 'INV-SKU-20260813-0009' }])
      mockDb.transaction.mockImplementationOnce(async (callback: (tx: unknown) => unknown) => callback({
        execute: txExecute,
        insert: vi.fn(() => ({ values })),
      }))

      await expect(createInventorySku({ productName: '测试商品' })).resolves.toEqual({
        success: true,
        skuId: 'INV-SKU-20260813-0010',
      })
      expect(values).toHaveBeenCalledWith(expect.objectContaining({
        skuId: 'INV-SKU-20260813-0010',
        productCode: 'INV-SKU-20260813-0010',
        productName: '测试商品',
      }))
      expect(renderSql(txExecute.mock.calls[0]?.[0])).toContain('pg_advisory_xact_lock')
      expect(renderSql(txExecute.mock.calls[0]?.[0])).toContain('inventory_skus:INV-SKU:20260813')
    } finally {
      vi.useRealTimers()
    }
  })

  it('福利方案编号按上海日期和当日序号由系统生成', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-08-13T04:00:00.000Z'))
    try {
      mockDb.select.mockReturnValueOnce(selectWithoutLimit([{
        skuId: 'SKU-1',
        productName: '测试商品',
        marketPurchasePrice: '100',
      }]))
      const values = vi.fn().mockResolvedValue(undefined)
      const txExecute = vi.fn()
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([{ value: 'PROMO-20260813-0041' }])
      mockDb.transaction.mockImplementationOnce(async (callback: (tx: unknown) => unknown) => callback({
        execute: txExecute,
        insert: vi.fn(() => ({ values })),
      }))

      await createInventoryPromotionPlan({
        name: '测试福利',
        startsAt: '2026-08-13',
        endsAt: '2026-08-31',
        items: [{ skuId: 'SKU-1', marketUnitDiscount: 10 }],
      })

      expect(values.mock.calls[0]?.[0]).toEqual(expect.objectContaining({
        planNo: 'PROMO-20260813-0042',
        name: '测试福利',
      }))
      expect(renderSql(txExecute.mock.calls[0]?.[0])).toContain('pg_advisory_xact_lock')
      expect(renderSql(txExecute.mock.calls[0]?.[0])).toContain('inventory_promotion_plans:PROMO:20260813')
    } finally {
      vi.useRealTimers()
    }
  })

  it('供应商编号始终由系统生成并忽略调用方伪造编号', async () => {
    const values = vi.fn().mockResolvedValue(undefined)
    mockDb.insert.mockReturnValueOnce({ values })

    const result = await createInventorySupplier({
      supplierId: 'MANUAL-SUPPLIER-ID',
      name: '测试供应商',
    } as never)

    expect(result.supplierId).toMatch(/^INV-SUP-[0-9a-f-]{36}$/)
    expect(result.supplierId).not.toBe('MANUAL-SUPPLIER-ID')
    expect(values).toHaveBeenCalledWith(expect.objectContaining({
      supplierId: result.supplierId,
      name: '测试供应商',
    }))
  })

  // ── #132：SKU 供货商关联供应商档案 ─────────────────────────────────
  // supplier 文本列不再收自由文本，改由 supplier_id 派生 —— ensureLotFromSku 建批次时
  // 取的正是这一列（engine.ts 的 `normalizeText(trace.supplier) ?? sku.supplier`），
  // 派生断了批次快照就会变空。

  it('新建 SKU 选中档案时同时写入 supplier_id 与冗余名，且加的是 FOR SHARE', async () => {
    const lock: { strength?: string } = {}
    const values = vi.fn().mockResolvedValue(undefined)
    // 供应商解析已移进事务内（要对档案行加 FOR SHARE），所以 tx 也得提供 select
    mockDb.transaction.mockImplementationOnce(async (callback: (tx: unknown) => unknown) => callback({
      select: vi.fn(() => selectWithLock([{ name: '广州美姿贺生物科技', isActive: true }], lock)),
      execute: vi.fn().mockResolvedValueOnce([]).mockResolvedValueOnce([{ value: 'INV-SKU-20260916-0001' }]),
      insert: vi.fn(() => ({ values })),
    }))

    await createInventorySku({ productName: '测试商品', supplierId: 'SUP-1' })

    expect(values).toHaveBeenCalledWith(expect.objectContaining({
      supplierId: 'SUP-1',
      supplier: '广州美姿贺生物科技',
    }))
    // 必须是 share：改名改的是 name 这个非键列，走 FOR NO KEY UPDATE，
    // FOR KEY SHARE 拦不住它 —— 降级成 'key share' 这条断言就会红
    expect(lock.strength).toBe('share')
  })

  it('新建 SKU 不能关联已停用的供应商', async () => {
    mockDb.select.mockReturnValueOnce(selectWithLock([{ name: '停用档案', isActive: false }], {}))

    await expect(createInventorySku({ productName: '测试商品', supplierId: 'SUP-OFF' }))
      .rejects.toThrow('已停用，无法关联到库存商品')
  })

  it('关联不存在的供应商时报 NOT_FOUND', async () => {
    mockDb.select.mockReturnValueOnce(selectWithLock([], {}))

    await expect(createInventorySku({ productName: '测试商品', supplierId: 'SUP-404' }))
      .rejects.toThrow('供应商不存在')
  })

  it('未提交 supplierId 时不动关联与名称快照（存量未匹配文本得以保留）', async () => {
    const set = vi.fn((_values: Record<string, unknown>) => ({ where: vi.fn().mockResolvedValue(undefined) }))
    mockDb.select.mockImplementation(() => selectWithLimit([{
      accountingPrice: null, marketPurchaseDiscount: null,
      sourceType: '供应链', ownerMarketId: null, supplierId: null,
    }]))
    mockDb.update.mockReturnValue({ set })

    await updateInventorySku('SKU-1', { productName: '改个名' })

    // drizzle 对 undefined 的列不生成 SET 子句 —— 这正是「两列都别动」的实现方式。
    // ⚠️ 单看这两条断言，把生产代码里的字段映射整行删掉它们照样绿（都还是 undefined）。
    // 所以补一条正向锚点证明 set 确实被正常调用过；而「传了 id 就写两列」由
    // 「显式传 null / 选中档案」那两条测试守护，删掉映射会让它们红。
    expect(set.mock.calls[0]?.[0]).toMatchObject({ productName: '改个名' })
    expect(set.mock.calls[0]?.[0]?.supplierId).toBeUndefined()
    expect(set.mock.calls[0]?.[0]?.supplier).toBeUndefined()
  })

  it('显式传 null 时关联与名称快照一起清空', async () => {
    const set = vi.fn(() => ({ where: vi.fn().mockResolvedValue(undefined) }))
    mockDb.select.mockImplementation(() => selectWithLimit([{
      accountingPrice: null, marketPurchaseDiscount: null,
      sourceType: '供应链', ownerMarketId: null, supplierId: 'SUP-1',
    }]))
    mockDb.update.mockReturnValue({ set })

    await updateInventorySku('SKU-1', { supplierId: null })

    expect(set).toHaveBeenCalledWith(expect.objectContaining({ supplierId: null, supplier: null }))
  })

  it('保持已关联但已停用的档案不报错，换成另一个停用档案才拦', async () => {
    // where 要返回 postgres.js 形状的受影响行数：保持停用档案会走 CAS 守卫，
    // 命中 0 行就抛 CONFLICT（见下一条测试）
    const set = vi.fn(() => ({ where: vi.fn().mockResolvedValue({ count: 1 }) }))
    const current = {
      accountingPrice: null, marketPurchaseDiscount: null,
      sourceType: '供应链', ownerMarketId: null, supplierId: 'SUP-OFF',
    }
    mockDb.update.mockReturnValue({ set })

    // 原样保存：档案虽已停用，但它就是当前关联值 —— 拦了就等于不让编辑这条 SKU
    mockDb.select
      .mockReturnValueOnce(selectWithLimit([current]))
      .mockReturnValueOnce(selectWithLock([{ name: '停用档案', isActive: false }], {}))
    await updateInventorySku('SKU-1', { supplierId: 'SUP-OFF' })
    expect(set).toHaveBeenCalledWith(expect.objectContaining({
      supplierId: 'SUP-OFF',
      supplier: '停用档案',
    }))

    // 换成另一个停用档案：停用语义是「不再采购」，这条要拦
    mockDb.select
      .mockReturnValueOnce(selectWithLimit([current]))
      .mockReturnValueOnce(selectWithLock([{ name: '另一个停用档案', isActive: false }], {}))
    await expect(updateInventorySku('SKU-1', { supplierId: 'SUP-OFF-2' }))
      .rejects.toThrow('已停用，无法关联到库存商品')
  })

  it('供应商改名同步回写关联 SKU 的冗余名，且对档案行加 FOR UPDATE', async () => {
    const supplierSet = vi.fn(() => ({ where: vi.fn().mockResolvedValue(undefined) }))
    // 把 where 的实参记下来：漏掉 `.where(eq(supplierId, ...))` 的话，一次改名会把
    // **全表** SKU 的 supplier 都改成这个名字 —— 只断言 set 的内容是拦不住这种数据损坏的
    const skuWhere = vi.fn().mockResolvedValue(undefined)
    const skuSet = vi.fn((_values: Record<string, unknown>) => ({ where: skuWhere }))
    const lock: { strength?: string } = {}
    let call = 0
    mockDb.select.mockReturnValueOnce(selectWithLimit([{ supplierId: 'SUP-1', name: '原来的供应商' }]))
    mockDb.transaction.mockImplementationOnce(async (callback: (tx: unknown) => unknown) => callback({
      select: vi.fn(() => selectWithLock([{ name: '原来的供应商' }], lock)),
      update: vi.fn(() => (call++ === 0 ? { set: supplierSet } : { set: skuSet })),
    }))

    await updateInventorySupplier('SUP-1', { name: '改名后的供应商' })
    // 旧名必须取自事务内锁到的行：用事务外快照的话，「甲改名 B 后乙把名字写回 A」
    // 会被判成「没改名」而跳过 SKU 回写，留下档案叫 A、SKU 文本是 B 的持久分叉
    expect(lock.strength).toBe('update')

    // 不回写的话：admin 列表读 JOIN 的实时名，而 staffApi 的 SKU 列表与新建批次读文本列，
    // 同一个供应商在两端显示成两个名字
    expect(skuSet).toHaveBeenCalledWith(expect.objectContaining({ supplier: '改名后的供应商' }))
    // 必须带 WHERE，且限定的是 supplier_id 这一列。
    // 列名要从 drizzle 的 SQL 片段里挖（renderSql 只渲染字面量片段，把 Column 对象渲成
    // [object Object]）—— 依赖内部结构，但这是能区分「限定了哪一列」的最直接方式。
    expect(skuWhere).toHaveBeenCalledTimes(1)
    const whereArg = skuWhere.mock.calls[0]?.[0] as { queryChunks?: Array<{ name?: string }> }
    expect(whereArg?.queryChunks?.some((chunk) => chunk?.name === 'supplier_id')).toBe(true)
  })

  it('只改联系方式时不回写 SKU 冗余名', async () => {
    const supplierSet = vi.fn(() => ({ where: vi.fn().mockResolvedValue(undefined) }))
    const update = vi.fn(() => ({ set: supplierSet }))
    mockDb.select.mockReturnValueOnce(selectWithLimit([{ supplierId: 'SUP-1', name: '原来的供应商' }]))
    mockDb.transaction.mockImplementationOnce(async (callback: (tx: unknown) => unknown) => callback({
      select: vi.fn(() => selectWithLock([{ name: '原来的供应商' }], {})),
      update,
    }))

    await updateInventorySupplier('SUP-1', { phone: '13900000000' })

    expect(update).toHaveBeenCalledTimes(1)
  })

  it('表单全量提交、名字没变时不回写 SKU', async () => {
    // 供应商页 submit() 是全量提交，每次编辑都带 name。丢掉「与 locked.name 的相等比较」
    // 的话，只改电话 / 停用也会触发整批关联 SKU 的 supplier 与 updated_at 被无因重写。
    // 这一侧此前没有任何断言覆盖 —— 改坏了 2800+ 条测试照样全绿。
    const supplierSet = vi.fn(() => ({ where: vi.fn().mockResolvedValue(undefined) }))
    const update = vi.fn(() => ({ set: supplierSet }))
    mockDb.select.mockReturnValueOnce(selectWithLimit([{ supplierId: 'SUP-1', name: '甲公司' }]))
    mockDb.transaction.mockImplementationOnce(async (callback: (tx: unknown) => unknown) => callback({
      select: vi.fn(() => selectWithLock([{ name: '甲公司' }], {})),
      update,
    }))

    await updateInventorySupplier('SUP-1', { name: '甲公司', phone: '13900000000' })

    // 只更新了档案本身，没有第二次 update（SKU 回写）
    expect(update).toHaveBeenCalledTimes(1)
  })

  it('改名撞唯一约束时抛可读的 CONFLICT（update 路径）', async () => {
    const duplicate = Object.assign(new Error('Failed query'), {
      cause: { code: '23505', constraint: 'uq_inventory_suppliers_name' },
    })
    mockDb.select.mockReturnValueOnce(selectWithLimit([{ supplierId: 'SUP-1', name: '甲公司' }]))
    mockDb.transaction.mockImplementationOnce(async () => { throw duplicate })

    await expect(updateInventorySupplier('SUP-1', { name: '乙公司' }))
      .rejects.toThrow('供应商名称「乙公司」已存在')
  })

  it('事务内发现名字已被他人改掉时照常回写', async () => {
    // 供应商表单是全量提交，停用/改电话时 name 照样在 payload 里。
    // 判据必须是「事务内锁到的旧名 vs 新名」：
    //  - 锁到的还是同一个名字 → 真的没改名 → 不回写（否则无因刷整批 SKU 的 updated_at）
    //  - 锁到的已经变成别人改的新名 → 这次提交实际是在改回去 → 必须回写
    const supplierSet = vi.fn(() => ({ where: vi.fn().mockResolvedValue(undefined) }))
    const skuSet = vi.fn((_values: Record<string, unknown>) => ({ where: vi.fn().mockResolvedValue(undefined) }))
    let call = 0
    mockDb.select.mockReturnValueOnce(selectWithLimit([{ supplierId: 'SUP-1', name: '甲公司' }]))
    mockDb.transaction.mockImplementationOnce(async (callback: (tx: unknown) => unknown) => callback({
      // 事务外读到「甲公司」，但等锁期间别人已经把它改成了「乙公司」
      select: vi.fn(() => selectWithLock([{ name: '乙公司' }], {})),
      update: vi.fn(() => (call++ === 0 ? { set: supplierSet } : { set: skuSet })),
    }))

    await updateInventorySupplier('SUP-1', { name: '甲公司', phone: '13900000000' })

    expect(skuSet).toHaveBeenCalledWith(expect.objectContaining({ supplier: '甲公司' }))
  })

  it('供应商重名抛可读的 CONFLICT，而不是把 PG 英文原文丢给用户', async () => {
    // action-error 既把 'violates unique constraint' 列进不可读片段，又有「没有中日韩字符
    // 就判不可读」的兜底 —— 不翻译的话用户只会看到 fallback「创建供应商失败」，
    // 而重名的那条若已停用，列表和下拉里都看不到，用户没有任何自诊断入口
    const duplicate = Object.assign(new Error('Failed query'), {
      cause: { code: '23505', constraint: 'uq_inventory_suppliers_name' },
    })
    mockDb.insert.mockReturnValueOnce({ values: vi.fn().mockRejectedValue(duplicate) })

    await expect(createInventorySupplier({ name: '广州美姿贺生物科技' }))
      .rejects.toThrow('供应商名称「广州美姿贺生物科技」已存在（可能是已停用的档案）')
  })

  it('保持停用档案时若该 SKU 已被他人改挂，CAS 命中 0 行并抛 CONFLICT', async () => {
    // currentSupplierId 是事务外读到的快照。别人在这中间把 SKU 改挂到别的档案，
    // 「保持当前停用档案」就变成了「换到一个停用档案」—— 正是上一条要拦的。
    // 所以放行前提被下推进 UPDATE 的 WHERE，用行的当前值再判一次。
    const set = vi.fn(() => ({ where: vi.fn().mockResolvedValue({ count: 0 }) }))
    mockDb.update.mockReturnValue({ set })
    mockDb.select
      .mockReturnValueOnce(selectWithLimit([{
        accountingPrice: null, marketPurchaseDiscount: null,
        sourceType: '供应链', ownerMarketId: null, supplierId: 'SUP-OFF',
      }]))
      .mockReturnValueOnce(selectWithLock([{ name: '停用档案', isActive: false }], {}))

    await expect(updateInventorySku('SKU-1', { supplierId: 'SUP-OFF' }))
      .rejects.toThrow('该库存商品的供货商已被他人修改')
  })

  it('正常保存（未涉及停用档案）不加 CAS 守卫，不会因受影响行数误判', async () => {
    // 只有「保持停用档案」这一种情况才加守卫；否则 where 只有主键条件，
    // 返回什么 count 都不该抛 —— 不然普通编辑会被误判成并发冲突
    const set = vi.fn(() => ({ where: vi.fn().mockResolvedValue(undefined) }))
    mockDb.update.mockReturnValue({ set })
    mockDb.select
      .mockReturnValueOnce(selectWithLimit([{
        accountingPrice: null, marketPurchaseDiscount: null,
        sourceType: '供应链', ownerMarketId: null, supplierId: 'SUP-1',
      }]))
      .mockReturnValueOnce(selectWithLock([{ name: '启用档案', isActive: true }], {}))

    await expect(updateInventorySku('SKU-1', { supplierId: 'SUP-1' })).resolves.toEqual({ success: true })
  })

  it('关联 SKU 数用 count(列) 而不是 count(*)', () => {
    // 组件测试是直接注入 linkedSkuCount 的，拦不住这个：leftJoin 之后 count(*) 会把
    // 「没有任何关联 SKU」的供应商数成 1（那一行的 SKU 侧全是 NULL，但行本身存在），
    // 页面就会显示「1 个」并在停用时弹出不存在的关联警告。count(列) 忽略 NULL 才对。
    const source = readFileSync(resolve(__dirname, 'engine.ts'), 'utf8')
    const listBlock = source.slice(
      source.indexOf('export const listInventorySuppliers'),
      source.indexOf('export const listInventorySupplierOptions'),
    )
    expect(listBlock).toMatch(/linkedSkuCount: sql<number>`cast\(count\(\$\{inventorySkus\.skuId\}\) as int\)`/)
    // 守的是 linkedSkuCount 这一处，不是整个函数块：#135 加的「共 N 条」总数查询
    // 也用 count(*)，但它对主表单独 count（见下一条），是正确用法。
    expect(listBlock).not.toMatch(/linkedSkuCount: sql<number>`cast\(count\(\*\)/)
    // 同时确认是 leftJoin（inner join 会让无关联的供应商整行消失）
    expect(listBlock).toMatch(/leftJoin\(inventorySkus/)
  })

  it('供应商状态筛选是三态：undefined=全部 / true=仅启用 / false=仅停用', () => {
    // 行为测试是 mock 的，SQL 条件怎么拼都不会红，只能靠源码断言。
    // 原写法 `filters.onlyActive ?? true` 把三态压成二值：「全部状态」变成只返回启用、
    // 「停用」变成返回全部 —— 页面三个选项里两个与标签不符。
    const source = readFileSync(resolve(__dirname, 'engine.ts'), 'utf8')
    const block = source.slice(
      source.indexOf('export const listInventorySuppliers'),
      source.indexOf('export const listInventorySupplierOptions'),
    )
    expect(block).toMatch(
      /filters\.onlyActive === true\) conditions\.push\(eq\(inventorySuppliers\.isActive, true\)\)/,
    )
    expect(block).toMatch(
      /filters\.onlyActive === false\) conditions\.push\(eq\(inventorySuppliers\.isActive, false\)\)/,
    )
    expect(block).not.toMatch(/filters\.onlyActive \?\? true/)
  })

  it('分页页长走白名单，且「不分页」那一态没被归一函数吃掉', () => {
    // `?size=7` 会让服务端每页 7 条而 UI 按 20 条算页数，尾部数据翻到哪页都够不到；
    // `?size=-5&page=2` 更糟：drizzle 丢弃负 limit 却照发负 offset → PG 报错 → 500。
    //
    // #281 起两支都收编进 `resolvePaging`，但 **`pageSize === undefined` 是「不分页、
    // 返回全量」的刻意语义**（办理台下拉共用这两个函数），而 `resolvePaging` 保证
    // pageSize ≥ 1、表达不了这一态 —— 所以必须保留外层的 `undefined` 三元判，
    // 不能整段塞进归一函数。这条守的就是那个外层判还在。
    const source = readFileSync(resolve(__dirname, 'engine.ts'), 'utf8')
    for (const [from, to] of [
      ['export const listInventorySuppliers', 'export const listInventorySupplierOptions'],
      ['export const listInventorySkuCompositions', 'export const listInventorySkuCompositionOptions'],
    ] as const) {
      const block = source.slice(source.indexOf(from), source.indexOf(to))
      expect(block).toMatch(/filters\.pageSize === undefined \? null : resolvePaging\(\{/)
      expect(block).toMatch(/allowedPageSizes: PAGE_SIZE_WHITELIST/)
      // 归一后不得再有手算 offset（契约要由单源一次给全）
      expect(block).not.toMatch(/\(\s*\w*[Pp]age\w*\s*-\s*1\s*\)\s*\*/)
    }
  })

  /**
   * 生成「字段: 条件 ?」的匹配式，**容忍任意空白与换行**。
   * 不能用 `toContain('字段: 条件 ?')` 字面量 —— 那等于把「三元必须写成单行」
   * 也钉进了守护：日后 prettier 换行（或接入 printWidth）会让断言误报红，
   * 而语义零变化。
   */
  function loosen(expr: string): string {
    return expr.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/ /g, '\\s+')
  }

  function guardPattern(field: string, cond: string): RegExp {
    return new RegExp(`${field}:\\s*${loosen(cond)}\\s*\\?`)
  }

  /** 同理，变量定义也不能用整行 `toContain` —— 赋值符后换行是无害格式化，不该让测试红 */
  function defPattern(name: string, expr: string): RegExp {
    return new RegExp(`const\\s+${name}\\s*=\\s*${loosen(expr)}`)
  }

  it('skuRow / lotRow 的价格遮蔽口径与组件的列裁剪逐列对应', () => {
    // skus-page / stocks-page 的列渲染测试是 **prop 注入**的，只能证明「给了这个档就这样渲染」，
    // 拦不住 engine 反向漂移（比如把 storeActualUnitPrice 改成 supplyVisible）——
    // 那会让列显示出来却整列是 null，正是 #135 组 5 要治的病反向复发。
    // 两个组件的注释里都写了「engine.test.ts 有守护」，这就是那个守护。
    const source = readFileSync(resolve(__dirname, 'engine.ts'), 'utf8')

    const skuBlock = source.slice(
      source.indexOf('function skuRow(row: {'),
      source.indexOf('function docRow(row: {'),
    )

    // ① 先钉住三个可见性变量的**定义**。只断言字段用了哪个变量是不够的 ——
    //    把 `marketVisible` 的定义放宽成 `!== 'none'`，所有字段断言照样绿，
    //    而供应链角色已经能看到门店价格了。
    expect(skuBlock).toMatch(defPattern('supplyVisible', "row.priceVisibility === 'all' || row.priceVisibility === 'supply_chain'"))
    expect(skuBlock).toMatch(defPattern('marketVisible', "row.priceVisibility === 'all' || row.priceVisibility === 'market'"))
    expect(skuBlock).toMatch(defPattern('anyPriceVisible', 'supplyVisible || marketVisible'))

    // ② 再逐字段钉住。**12 个价格相关字段一个都不能漏** ——
    //    只守 5 个的话，把 accountingPrice 从 supplyVisible 放宽成 anyPriceVisible
    //    （市场角色会拿到供应链核算价）不会被任何断言拦住。
    const SKU_PRICE_GUARDS: Array<[string, string]> = [
      ['retailPrice', "row.priceVisibility === 'all'"],
      ['accountingPrice', 'supplyVisible'],
      ['supplyChainPurchasePrice', 'supplyVisible'],
      ['marketPurchasePrice', 'anyPriceVisible'],
      ['marketPurchasePriceMode', 'supplyVisible'],
      ['marketPurchasePriceOverrideReason', 'supplyVisible'],
      ['storePurchasePrice', 'marketVisible'],
      ['marketStaffPurchasePrice', 'marketVisible'],
      ['marketPurchaseDiscount', 'anyPriceVisible'],
      ['storePurchaseDiscount', 'marketVisible'],
      ['staffPurchaseDiscount', 'marketVisible'],
      ['itemCompanyPurchasePrice', 'supplyVisible'],
    ]
    for (const [field, cond] of SKU_PRICE_GUARDS) {
      expect(skuBlock).toMatch(guardPattern(field, cond))
    }

    const lotBlock = source.slice(
      source.indexOf('function lotRow('),
      source.indexOf('function inventoryDocScopeSql('),
    )
    expect(lotBlock).toMatch(defPattern('supplyVisible', "priceVisibility === 'all' || priceVisibility === 'supply_chain'"))
    expect(lotBlock).toMatch(defPattern('marketVisible', "priceVisibility === 'all' || priceVisibility === 'market'"))
    const LOT_PRICE_GUARDS: Array<[string, string]> = [
      ['supplyChainUnitCost', 'supplyVisible'],
      ['marketActualUnitPrice', 'supplyVisible || marketVisible'],
      ['storeActualUnitPrice', 'marketVisible'],
    ]
    for (const [field, cond] of LOT_PRICE_GUARDS) {
      expect(lotBlock).toMatch(guardPattern(field, cond))
    }
    // 反向：门店实际价**不能**放宽成 supplyVisible（那样供应链角色会看到门店价）
    expect(lotBlock).not.toMatch(/storeActualUnitPrice: supplyVisible \?/)
  })

  it('五支列表查询的页码全部走 @/lib/paging 单源，没有内联写法', () => {
    // `Math.max(1, page || 1)` 只兜得住 NaN/0。`?page=1.5` 会让 offset 变成
    // (1.5-1)*20 = 10 → 返回第 11–30 条，而客户端 Pagination 内部 floor 后高亮第 1 页，
    // 用户看到的既不是第 1 页也不是第 2 页；`?page=Infinity` 直接把 SQL 打挂。
    //
    // #281 起归一实现搬到 `src/lib/paging.ts`（admin 单源，另有 37 处调用点），
    // **实现本身的守护挪到了 `src/lib/paging.test.ts`**；这里只守「本文件确实在用它」。
    const source = readFileSync(resolve(__dirname, 'engine.ts'), 'utf8')
    // 必须是 import 进来的，不能是本文件又写了一份
    expect(source).toMatch(/import \{ resolvePaging \} from '@\/lib\/paging'/)
    expect(source).not.toMatch(/function normalizePage/)
    // 五支列表查询必须全部走它，不能有漏网的内联写法
    expect(source.match(/resolvePaging\(\{/g)).toHaveLength(5)
    // 剥掉行注释再扫 —— 文件顶部的收编说明里就复述了这些旧写法当反例，
    // 不剥的话这条断言会被自己的注释绊倒（而不是被真实复发绊倒）。
    const code = source.replace(/^\s*\/\/.*$/gm, '')
    expect(code).not.toMatch(/Math\.max\(1, filters\.page/)
    // offset 一律由单源给出，本文件不再手算
    expect(code).not.toMatch(/\(\s*\w*[Pp]age\w*\s*-\s*1\s*\)\s*\*/)
  })

  it('SKU 映射的 total 取过滤后的长度，不是全量长度', () => {
    // 这一支的 status / keyword 过滤都在内存里做（configurationStatus 是按
    // components 算出来的派生字段，没法下推成 WHERE）。total 若取 productRows.length，
    // 筛完之后「共 N 条」还是全量数字，页数也跟着错。
    const source = readFileSync(resolve(__dirname, 'engine.ts'), 'utf8')
    const block = source.slice(
      source.indexOf('export const listInventorySkuCompositions'),
      source.indexOf('export const listInventorySkuCompositionOptions'),
    )
    expect(block).toMatch(/total: filtered\.length/)
    expect(block).not.toMatch(/total: productRows\.length/)
    // 切片同样必须基于 filtered
    expect(block).toMatch(/filtered\.slice\(paged\.offset, paged\.offset \+ paged\.pageSize\)/)
  })

  it('供应商总数查询绕开 leftJoin（否则「共 N 条」会被关联 SKU 放大）', () => {
    // 这条拦的是「顺手把 total 塞进主查询」：leftJoin 之后 count(*) 数的是 join 后的行数，
    // 一个有 3 个关联 SKU 的供应商会被算成 3 条，分页总数与页数全错。
    const source = readFileSync(resolve(__dirname, 'engine.ts'), 'utf8')
    const listBlock = source.slice(
      source.indexOf('export const listInventorySuppliers'),
      source.indexOf('export const listInventorySupplierOptions'),
    )
    const totalBlock = listBlock.slice(
      listBlock.indexOf('const [totalRow]'),
      listBlock.indexOf('const query ='),
    )
    expect(totalBlock).toMatch(/count\(\*\)/)
    expect(totalBlock).not.toMatch(/leftJoin/)
  })

  it('pageSize 缺省时不加 limit（办理台下拉要整份名单）', () => {
    // 办理台的供应商下拉与列表页共用 listInventorySuppliers。给它兜一个默认页长，
    // 「自采产品入库」里排在 20 名之后的供应商就会静默消失、且没有任何报错。
    const source = readFileSync(resolve(__dirname, 'engine.ts'), 'utf8')
    const listBlock = source.slice(
      source.indexOf('export const listInventorySuppliers'),
      source.indexOf('export const listInventorySupplierOptions'),
    )
    // 收编后「不分页」这一态由 `paged === null` 表达（resolvePaging 保证 pageSize ≥ 1，
    // 表达不了 undefined），三元判必须留在归一函数**外面**。
    expect(listBlock).toMatch(/const paged = filters\.pageSize === undefined \? null : resolvePaging\(\{/)
    expect(listBlock).toMatch(/paged\s*\n?\s*\?\s*await query\.limit\(paged\.pageSize\)\.offset\(paged\.offset\)/)
    expect(listBlock).toMatch(/:\s*await query\b/)
    // 不得出现 `filters.pageSize ?? 20` 这类默认值
    expect(listBlock).not.toMatch(/filters\.pageSize\s*\?\?/)
  })

  it('SKU 列表的 supplierName 来自档案表 JOIN，不是 SKU 自己的冗余列', () => {
    // 组件测试是直接注入 supplierName 的，只能证明「组件优先显示它」。
    // 把生产查询改成 `supplierName: inventorySkus.supplier` 组件测试照样绿 ——
    // 那样档案改名后列表就不再实时跟随了（退回冗余列的值）。
    const source = readFileSync(resolve(__dirname, 'engine.ts'), 'utf8')
    const listBlock = source.slice(
      source.indexOf('export const listInventorySkus'),
      source.indexOf('export const createInventorySku'),
    )
    expect(listBlock).toMatch(/supplierName: inventorySuppliers\.name/)
    expect(listBlock).toMatch(/leftJoin\(inventorySuppliers, eq\(inventorySkus\.supplierId, inventorySuppliers\.supplierId\)\)/)
  })

  it('实时关联数查询按 supplier_id 过滤', () => {
    // 组件测试全都 mock 掉了这个 action。误删 where 的话，页面会把全库 SKU 总数
    // 当成当前供应商的关联数（停用任何供应商都会弹出巨大的关联警告）。
    const source = readFileSync(resolve(__dirname, 'engine.ts'), 'utf8')
    const block = source.slice(
      source.indexOf('export const countInventorySkusBySupplier'),
      source.indexOf('export const createInventorySupplier'),
    )
    expect(block).toMatch(/\.where\(eq\(inventorySkus\.supplierId, supplierId\)\)/)
  })

  it('供应商列表把 linkedSkuCount 映射进返回行，并附带总数', async () => {
    // 两次 db.select：先总数（from→where，无 join），再列表（from→leftJoin→…）。
    mockDb.select
      .mockReturnValueOnce({
        from: () => ({ where: async () => [{ total: 7 }] }),
      } as never)
      .mockReturnValueOnce({
        from: () => ({
          leftJoin: () => ({
            where: () => ({
              groupBy: () => ({
                orderBy: async () => [
                  {
                    supplier: {
                      supplierId: 'SUP-1', name: '甲公司', contactName: null, phone: null,
                      address: null, isActive: true, remark: null,
                      createdAt: new Date('2026-08-01T00:00:00Z'),
                      updatedAt: new Date('2026-08-01T00:00:00Z'),
                    },
                    linkedSkuCount: 3,
                  },
                ],
              }),
            }),
          }),
        }),
      } as never)

    await expect(listInventorySuppliers({})).resolves.toEqual({
      data: [expect.objectContaining({ supplierId: 'SUP-1', linkedSkuCount: 3 })],
      total: 7,
    })
  })

  it('不传 pageSize 时不调用 limit', async () => {
    // 变异守护：给 listInventorySuppliers 兜一个默认页长的话，这里的 limit 会被调用。
    const limit = vi.fn()
    mockDb.select
      .mockReturnValueOnce({ from: () => ({ where: async () => [{ total: 0 }] }) } as never)
      .mockReturnValueOnce({
        from: () => ({
          leftJoin: () => ({
            where: () => ({
              groupBy: () => ({
                orderBy: () => Object.assign(Promise.resolve([]), { limit }),
              }),
            }),
          }),
        }),
      } as never)

    await listInventorySuppliers({})
    expect(limit).not.toHaveBeenCalled()
  })

  it('创建后不能跨市场或转换库存 SKU 来源', async () => {
    mockDb.select.mockImplementation(() => selectWithLimit([{
      accountingPrice: null,
      marketPurchaseDiscount: null,
      sourceType: '市场自采',
      ownerMarketId: 'MARKET-1',
    }]))

    await expect(updateInventorySku('SKU-1', {
      sourceType: '供应链',
      ownerMarketId: null,
    })).rejects.toThrow('来源和归属市场创建后不可修改')
  })

  it('非供应链 SKU 未提交市场进货价时保留历史值，不覆盖 WorkFine 快照', async () => {
    const set = vi.fn((_values: Record<string, unknown>) => ({ where: vi.fn().mockResolvedValue(undefined) }))
    mockDb.select.mockImplementation(() => selectWithLimit([{
      accountingPrice: '100',
      marketPurchaseDiscount: '0.8',
      marketPurchasePrice: '88',
      marketPurchasePriceMode: null,
      marketPurchasePriceOverrideReason: null,
      sourceType: '市场自采',
      ownerMarketId: 'MARKET-1',
    }]))
    mockDb.update.mockReturnValue({ set })

    // 只改零售价、不提交进货价 —— Drizzle 对 undefined 值列不生成 SET 子句，历史快照得以保留。
    await updateInventorySku('SKU-1', { retailPrice: 200 })

    expect(set).toHaveBeenCalledWith(expect.objectContaining({ retailPrice: '200' }))
    expect(set.mock.calls[0]?.[0]?.marketPurchasePrice).toBeUndefined()
  })

  it('非供应链 SKU 显式清空市场进货价时回退公式派生值', async () => {
    const set = vi.fn(() => ({ where: vi.fn().mockResolvedValue(undefined) }))
    mockDb.select.mockImplementation(() => selectWithLimit([{
      accountingPrice: '100',
      marketPurchaseDiscount: '0.8',
      marketPurchasePrice: '88',
      marketPurchasePriceMode: null,
      marketPurchasePriceOverrideReason: null,
      sourceType: '市场自采',
      ownerMarketId: 'MARKET-1',
    }]))
    mockDb.update.mockReturnValue({ set })

    await updateInventorySku('SKU-1', { marketPurchasePrice: null })

    expect(set).toHaveBeenCalledWith(expect.objectContaining({
      marketPurchasePrice: '80',
    }))
  })

  it('非供应链 SKU 历史值为空且公式输入变化时补算派生值', async () => {
    const set = vi.fn(() => ({ where: vi.fn().mockResolvedValue(undefined) }))
    mockDb.select.mockImplementation(() => selectWithLimit([{
      accountingPrice: '100',
      marketPurchaseDiscount: '0.8',
      marketPurchasePrice: null,
      marketPurchasePriceMode: null,
      marketPurchasePriceOverrideReason: null,
      sourceType: '市场自采',
      ownerMarketId: 'MARKET-1',
    }]))
    mockDb.update.mockReturnValue({ set })

    await updateInventorySku('SKU-1', { accountingPrice: 200, marketPurchaseDiscount: 0.5 })

    expect(set).toHaveBeenCalledWith(expect.objectContaining({
      marketPurchasePrice: '100',
    }))
  })

  it('新建非供应链 SKU 未提交市场进货价时按公式初始化', async () => {
    // normalizeSkuOwnerMarket 会先同步库存主体（db.execute）再查归属市场（db.select）。
    mockDb.execute.mockResolvedValue(undefined)
    mockDb.select.mockImplementation(() => selectWithLimit([{ id: 'MARKET-1' }]))
    const values = vi.fn().mockResolvedValue(undefined)
    const txExecute = vi.fn()
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{ value: 'INV-SKU-20260813-0009' }])
    mockDb.transaction.mockImplementationOnce(async (callback: (tx: unknown) => unknown) => callback({
      execute: txExecute,
      insert: vi.fn(() => ({ values })),
    }))

    await createInventorySku({
      productName: '市场自采商品',
      sourceType: '市场自采',
      ownerMarketId: 'MARKET-1',
      accountingPrice: 100,
      marketPurchaseDiscount: 0.8,
    })

    expect(values).toHaveBeenCalledWith(expect.objectContaining({
      marketPurchasePrice: '80',
    }))
  })

  it('允许手工填写市场进货价且不要求核算价和市场折扣', async () => {
    const set = vi.fn(() => ({ where: vi.fn().mockResolvedValue(undefined) }))
    mockDb.select.mockImplementation(() => selectWithLimit([{
      accountingPrice: null,
      marketPurchaseDiscount: null,
      marketPurchasePrice: '78',
      marketPurchasePriceMode: '手工覆盖',
      marketPurchasePriceOverrideReason: '历史维护',
      sourceType: '供应链',
      ownerMarketId: null,
    }]))
    mockDb.update.mockReturnValue({ set })

    await updateInventorySku('SKU-1', {
      marketPurchasePrice: 123,
      marketPurchasePriceMode: '手工覆盖',
      marketPurchasePriceOverrideReason: '供应商临时调价',
    })

    expect(set).toHaveBeenCalledWith(expect.objectContaining({
      marketPurchasePrice: '123',
    }))
  })

  it('手工市场进货价优先于核算价和市场折扣公式', async () => {
    const set = vi.fn(() => ({ where: vi.fn().mockResolvedValue(undefined) }))
    mockDb.select.mockImplementation(() => selectWithLimit([{
      accountingPrice: '4000',
      marketPurchaseDiscount: '0.25',
      marketPurchasePrice: '1000',
      marketPurchasePriceMode: '手工覆盖',
      marketPurchasePriceOverrideReason: '历史维护',
      sourceType: '供应链',
      ownerMarketId: null,
    }]))
    mockDb.update.mockReturnValue({ set })

    await updateInventorySku('SKU-1', {
      accountingPrice: 5000,
      marketPurchaseDiscount: 25,
      marketPurchasePrice: 1200,
      marketPurchasePriceMode: '手工覆盖',
      marketPurchasePriceOverrideReason: '合同结算价',
    })

    expect(set).toHaveBeenCalledWith(expect.objectContaining({
      accountingPrice: '5000',
      marketPurchaseDiscount: '25',
      marketPurchasePrice: '1200',
    }))
  })

  it('市场进货价留空且公式完整时自动计算', async () => {
    const set = vi.fn(() => ({ where: vi.fn().mockResolvedValue(undefined) }))
    mockDb.select.mockImplementation(() => selectWithLimit([{
      accountingPrice: null,
      marketPurchaseDiscount: null,
      marketPurchasePrice: null,
      marketPurchasePriceMode: '公式',
      sourceType: '供应链',
      ownerMarketId: null,
    }]))
    mockDb.update.mockReturnValue({ set })

    await updateInventorySku('SKU-1', {
      accountingPrice: 4000,
      marketPurchaseDiscount: 25,
      marketPurchasePrice: null,
    })

    expect(set).toHaveBeenCalledWith(expect.objectContaining({
      marketPurchasePrice: '1000',
    }))
  })

  it('核算价或市场折扣单独填写时允许保存并保留现有市场进货价', async () => {
    const set = vi.fn(() => ({ where: vi.fn().mockResolvedValue(undefined) }))
    mockDb.select.mockImplementation(() => selectWithLimit([{
      accountingPrice: null,
      marketPurchaseDiscount: null,
      marketPurchasePrice: '78',
      marketPurchasePriceMode: '公式',
      marketPurchasePriceOverrideReason: null,
      sourceType: '供应链',
      ownerMarketId: null,
    }]))
    mockDb.update.mockReturnValue({ set })

    await updateInventorySku('SKU-1', {
      accountingPrice: 100,
    })

    expect(set).toHaveBeenCalledWith(expect.objectContaining({
      accountingPrice: '100',
      marketPurchasePrice: null,
    }))
  })

  it('明确清空市场进货价且公式不完整时保存为空', async () => {
    const set = vi.fn(() => ({ where: vi.fn().mockResolvedValue(undefined) }))
    mockDb.select.mockImplementation(() => selectWithLimit([{
      accountingPrice: '4000',
      marketPurchaseDiscount: '0.25',
      marketPurchasePrice: '1000',
      sourceType: '供应链',
      ownerMarketId: null,
    }]))
    mockDb.update.mockReturnValue({ set })

    await updateInventorySku('SKU-1', {
      accountingPrice: null,
      marketPurchaseDiscount: null,
      marketPurchasePrice: null,
    })

    expect(set).toHaveBeenCalledWith(expect.objectContaining({
      accountingPrice: null,
      marketPurchaseDiscount: null,
      marketPurchasePrice: null,
    }))
  })

  it('福利方案不能传入市场基础价覆盖产品资料', async () => {
    await expect(createInventoryPromotionPlan({
      name: '福利方案',
      startsAt: '2026-08-01',
      endsAt: '2026-08-31',
      items: [{
        skuId: 'SKU-1',
        marketUnitDiscount: 10,
        marketBasePrice: 1,
      }],
    } as never)).rejects.toThrow('福利方案只允许设置单价优惠')
  })

  it('组合福利必须配置至少两种不同产品且每项都有数量下限', async () => {
    const baseInput = {
      name: '组合福利',
      startsAt: '2026-08-01',
      endsAt: '2026-08-31',
      ruleType: '组合' as const,
    }

    await expect(createInventoryPromotionPlan({
      ...baseInput,
      items: [{ skuId: 'SKU-1', marketUnitDiscount: 10, reportMinQuantity: 1 }],
    })).rejects.toThrow('组合福利至少需要两条不同产品明细')

    await expect(createInventoryPromotionPlan({
      ...baseInput,
      items: [
        { skuId: 'SKU-1', marketUnitDiscount: 10, reportMinQuantity: 1 },
        { skuId: 'SKU-1', marketUnitDiscount: 5, reportMinQuantity: 1 },
      ],
    })).rejects.toThrow('组合福利中同一产品只能出现一次')

    await expect(createInventoryPromotionPlan({
      ...baseInput,
      items: [
        { skuId: 'SKU-1', marketUnitDiscount: 10, reportMinQuantity: 1 },
        { skuId: 'SKU-2', marketUnitDiscount: 5 },
      ],
    })).rejects.toThrow('组合福利必须填写每个产品的数量下限')
  })

  it('福利方案创建和更新必须具备价格查看权限', async () => {
    vi.mocked(isAdminScope).mockReturnValue(false)
    vi.mocked(hasPermission).mockReturnValue(false)
    const input = {
      name: '福利方案',
      startsAt: '2026-08-01',
      endsAt: '2026-08-31',
      items: [{ skuId: 'SKU-1', marketUnitDiscount: 10 }],
    }

    await expect(createInventoryPromotionPlan(input)).rejects.toThrow('无权设置市场报货福利价格')
    await expect(updateInventoryPromotionPlan('PROMO-1', input)).rejects.toThrow('无权设置市场报货福利价格')
    expect(mockDb.select).not.toHaveBeenCalled()
  })
})

describe('库存可用量与收货复核', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(isAdminScope).mockReturnValue(true)
    mockGetSession.mockResolvedValue(SESSION)
    mockDb.execute.mockResolvedValue([])
    mockDb.select.mockReset()
    mockDb.select.mockImplementation(() => selectWithLimit([{ locationType: '总部' }]))
    mockDb.transaction.mockReset()
  })

  it('通用建单忽略客户端金额并按锁定批次派生明细和表头金额', async () => {
    const txExecute = vi.fn()
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{
        ...lotRow(),
        supply_chain_unit_cost: '20',
        market_standard_unit_price: '60',
        market_unit_discount: '6',
        market_actual_unit_price: '54',
        store_standard_unit_price: '50',
        store_unit_discount: '5',
        store_actual_unit_price: '45',
      }])
      .mockResolvedValueOnce([{
        product_name: '测试 SKU',
        source_type: '供应链',
        owner_market_id: null,
      }])
      .mockResolvedValueOnce([{ quantity: '0' }])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([])
    const headerValues = vi.fn().mockResolvedValue(undefined)
    const itemValues = vi.fn(() => ({ returning: vi.fn().mockResolvedValue([{ id: 1 }]) }))
    const totalAmountWhere = vi.fn().mockResolvedValue(undefined)
    const totalAmountSet = vi.fn(() => ({ where: totalAmountWhere }))
    const txInsert = vi.fn()
      .mockReturnValueOnce({ values: headerValues })
      .mockReturnValueOnce({ values: itemValues })
    const txUpdate = vi.fn(() => ({ set: totalAmountSet }))
    mockDb.transaction.mockImplementation(async (callback: (tx: unknown) => unknown) => callback({
      execute: initializedCutoverExecutor(txExecute),
      insert: txInsert,
      update: txUpdate,
    }))

    await createInventoryCoreDoc({
      docType: '内部领用',
      sourceOrgNodeId: 'HQ',
      totalAmount: 9999,
      items: [{
        skuId: 'SKU-1',
        lotId: 1,
        quantity: 2,
        standardUnitPrice: 999,
        unitDiscount: 999,
        actualUnitPrice: 999,
        amount: 9999,
        supplyChainUnitCost: 999,
        marketStandardUnitPrice: 999,
        marketUnitDiscount: 999,
        marketActualUnitPrice: 999,
        storeStandardUnitPrice: 999,
        storeUnitDiscount: 999,
        storeActualUnitPrice: 999,
      }],
    })

    expect(headerValues).toHaveBeenCalledWith(expect.objectContaining({ totalAmount: null }))
    expect(itemValues).toHaveBeenCalledWith(expect.objectContaining({
      standardUnitPrice: '50',
      unitDiscount: '5',
      actualUnitPrice: '45',
      amount: '90',
      supplyChainUnitCost: '20',
      marketActualUnitPrice: '54',
      storeActualUnitPrice: '45',
    }))
    expect(totalAmountSet).toHaveBeenCalledWith(expect.objectContaining({ totalAmount: '90' }))
    expect(totalAmountWhere).toHaveBeenCalled()
  })

  it('通用出库不得耗用已被退货预留的库存', async () => {
    const txExecute = vi.fn()
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([lotRow()])
      .mockResolvedValueOnce([{
        product_name: '测试 SKU',
        source_type: '供应链',
        owner_market_id: null,
      }])
      .mockResolvedValueOnce([{ quantity: '5' }])
    const txInsert = vi.fn()
      .mockReturnValueOnce({ values: vi.fn().mockResolvedValue(undefined) })
      .mockReturnValueOnce({
        values: vi.fn(() => ({ returning: vi.fn().mockResolvedValue([{ id: 1 }]) })),
      })
    mockDb.transaction.mockImplementation(async (callback: (tx: unknown) => unknown) => callback({
      execute: initializedCutoverExecutor(txExecute),
      insert: txInsert,
    }))

    await expect(createInventoryCoreDoc({
      docType: '内部领用',
      sourceOrgNodeId: 'HQ',
      items: [{ skuId: 'SKU-1', lotId: 1, quantity: 6 }],
    } as never)).rejects.toThrow('库存不足：测试 SKU 可用 5')
  })

  it('通用审批出库不得耗用已被退货预留的库存', async () => {
    const txExecute = vi.fn()
      .mockResolvedValueOnce([{
        id: 'MBS-260809-0001',
        doc_type: '市场产品报损',
        status: '待审批',
        source_org_node_id: 'MARKET-1',
      }])
      .mockResolvedValueOnce([{ location_id: 'MARKET-1' }])
      .mockResolvedValueOnce([{ id: 1, lot_id: 1, quantity: '6' }])
      .mockResolvedValueOnce([lotRow()])
      .mockResolvedValueOnce([{ quantity: '5' }])
    mockDb.transaction.mockImplementation(async (callback: (tx: unknown) => unknown) => callback({
      execute: initializedCutoverExecutor(txExecute),
    }))

    await expect(approveInventoryCoreDoc('MBS-260809-0001'))
      .rejects.toThrow('库存不足：测试 SKU 可用 5')
  })

  it('收货确认会拒绝历史异常的分院调货单', async () => {
    const txExecute = vi.fn().mockResolvedValueOnce([{
      id: 'DTO-260809-0001',
      doc_type: '分院调货出库',
      status: '待收货',
      source_org_node_id: 'MARKET-1',
      target_org_node_id: 'STORE-1',
      total_quantity: '1',
      remark: null,
    }])
    mockDb.transaction.mockImplementation(async (callback: (tx: unknown) => unknown) => callback({
      execute: initializedCutoverExecutor(txExecute),
    }))
    mockDb.select.mockImplementation(() => selectWithoutLimit([
      { locationId: 'MARKET-1', orgNodeId: 'MARKET-1', locationType: '市场', parentLocationId: 'HQ' },
      { locationId: 'STORE-1', orgNodeId: 'STORE-1', locationType: '门店', parentLocationId: 'MARKET-1' },
    ]))

    await expect(confirmInventoryCoreReceive('DTO-260809-0001'))
      .rejects.toThrow('分院调货的出入库主体必须均为门店')
  })
})

describe('库存主体启停同步', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockDb.execute.mockResolvedValue([])
  })

  it('运行时同步继承组织停用与门店闭店状态（探测无结果时保守执行 UPSERT）', async () => {
    await syncInventoryLocations()

    const [probeSql, orgSql, storeSql] = mockDb.execute.mock.calls.map(([query]) => renderSql(query))
    expect(probeSql).toContain('AS drifted')
    expect(orgSql).toContain('parent_location_id, is_active')
    expect(orgSql).toContain('SELECT id, type, name, id, parent_id, is_active')
    expect(orgSql).toContain('is_active = EXCLUDED.is_active')
    expect(storeSql).toContain('parent_location_id, is_active')
    expect(storeSql).toContain('COALESCE(o.is_active, false) AND NOT s.is_closed')
    expect(storeSql).toContain('is_active = EXCLUDED.is_active')
  })

  it('漂移探测覆盖全部同步列，无漂移时跳过全表 UPSERT', async () => {
    mockDb.execute.mockResolvedValue([{ drifted: false }])

    await syncInventoryLocations()

    expect(mockDb.execute).toHaveBeenCalledTimes(1)
    const probeSql = renderSql(mockDb.execute.mock.calls[0][0])
    // 反连接缺失检测 + 每个同步列的 IS DISTINCT FROM 漂移检测缺一不可。
    expect(probeSql).toContain('loc.location_id IS NULL')
    // org_nodes.type 是 pgEnum，text 比较语境无隐式转换，必须显式 ::text（42883）
    expect(probeSql).toContain('loc.location_type IS DISTINCT FROM o.type::text')
    expect(probeSql).toContain('loc.name IS DISTINCT FROM o.name')
    expect(probeSql).toContain('loc.parent_location_id IS DISTINCT FROM o.parent_id')
    expect(probeSql).toContain('loc.is_active IS DISTINCT FROM o.is_active')
    expect(probeSql).toContain("loc.location_type IS DISTINCT FROM '门店'")
    expect(probeSql).toContain('loc.name IS DISTINCT FROM s.store_name')
    expect(probeSql).toContain('loc.org_node_id IS DISTINCT FROM s.org_node_id')
    expect(probeSql).toContain('loc.store_id IS DISTINCT FROM s.store_id')
    expect(probeSql).toContain('loc.is_active IS DISTINCT FROM (COALESCE(o.is_active, false) AND NOT s.is_closed)')
    expect(probeSql).not.toContain('INSERT INTO inventory_locations')
  })

  it('探测到漂移时照常执行两条全表 UPSERT', async () => {
    mockDb.execute.mockResolvedValue([{ drifted: true }])

    await syncInventoryLocations()

    expect(mockDb.execute).toHaveBeenCalledTimes(3)
    const upserts = mockDb.execute.mock.calls
      .map(([query]) => renderSql(query))
      .filter((query) => query.includes('INSERT INTO inventory_locations'))
    expect(upserts).toHaveLength(2)
  })

  it('库存主体加固迁移使用与运行时相同的库存主体启停规则', () => {
    const migration = readFileSync(
      resolve(process.cwd(), '../db/migrations/0009_inventory_integrity_guards.sql'),
      'utf8',
    )

    expect(migration).toContain('location_id, location_type, name, org_node_id, parent_location_id, is_active')
    expect(migration).toContain('SELECT node.id, node.type, node.name, node.id, node.parent_id, node.is_active')
    expect(migration).toContain('COALESCE(node.is_active, false) AND NOT store.is_closed')
    expect(migration).toContain('is_active = EXCLUDED.is_active')
  })
})

describe('库存主体筛选 scope', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(isAdminScope).mockReturnValue(false)
    mockDb.execute.mockResolvedValue([])
  })

  it('使用当前 action 收紧后的市场和门店 scope 生成选项', async () => {
    mockGetSession.mockResolvedValue({
      employeeId: 'E001',
      name: '市场用户',
      phone: '13800000000',
      roles: [{
        role: 'finance',
        scopeId: 'M1',
        scopeType: '市场',
        actions: ['inventory:stock_list'],
        scopeStoreIds: ['S1'],
        scopeOrgNodeIds: ['M1', 'N-S1'],
      }],
      permissions: {
        actions: ['inventory:stock_list'],
        scopeStoreIds: ['S1'],
        scopeOrgNodeIds: ['M1', 'N-S1'],
      },
    })
    mockDb.select.mockReturnValue(selectWithOrder([
      { locationId: 'HQ', locationType: '总部', name: '总部', orgNodeId: 'HQ', storeId: null, parentLocationId: null, isActive: true },
      { locationId: 'M1', locationType: '市场', name: '南昌市场', orgNodeId: 'M1', storeId: null, parentLocationId: 'HQ', isActive: true },
      { locationId: 'M2', locationType: '市场', name: '九江市场', orgNodeId: 'M2', storeId: null, parentLocationId: 'HQ', isActive: true },
      { locationId: 'S1', locationType: '门店', name: '红谷滩店', orgNodeId: 'N-S1', storeId: 'S1', parentLocationId: 'M1', isActive: true },
      { locationId: 'S2', locationType: '门店', name: '九江店', orgNodeId: 'N-S2', storeId: 'S2', parentLocationId: 'M2', isActive: true },
    ]))

    await expect(listInventoryLocationFilterOptions()).resolves.toEqual({
      headquarters: [],
      markets: [{
        locationId: 'M1',
        name: '南昌市场',
        canSelectInventory: true,
        stores: [{ locationId: 'S1', name: '红谷滩店' }],
      }],
      defaultLocationId: 'M1',
    })
  })
})

describe('市场间调货接收主体候选（#340）', () => {
  /** 只绑一个市场的「市场库存财务」：scope 里只有 M1 与其下属门店 */
  const SINGLE_MARKET_SESSION = {
    employeeId: 'E-MK',
    name: '市场库存财务',
    phone: '13800000001',
    roles: [{
      role: 'inventory_market_finance',
      scopeId: 'M1',
      scopeType: '市场',
      actions: ['inventory:market_operate', 'inventory:stock_list'],
      scopeStoreIds: ['S1'],
      scopeOrgNodeIds: ['M1', 'N-S1'],
    }],
    permissions: {
      actions: ['inventory:market_operate', 'inventory:stock_list'],
      scopeStoreIds: ['S1'],
      scopeOrgNodeIds: ['M1', 'N-S1'],
    },
  }

  function captureSelect(rows: unknown[]) {
    const sink: { fields?: Record<string, unknown>; where?: unknown } = {}
    mockDb.select.mockImplementation((fields: Record<string, unknown>) => {
      sink.fields = fields
      return {
        from: () => ({
          where: (cond: unknown) => {
            sink.where = cond
            return { orderBy: async () => rows }
          },
        }),
      }
    })
    return sink
  }

  beforeEach(() => {
    vi.clearAllMocks()
    mockDb.select.mockReset()
    mockDb.execute.mockReset()
    mockDb.execute.mockResolvedValue([])
    vi.mocked(isAdminScope).mockReturnValue(false)
    mockGetSession.mockResolvedValue(SINGLE_MARKET_SESSION)
  })

  it('单市场账号也能拿到其他市场：条件里没有任何 scope 收窄', async () => {
    const sink = captureSelect([
      { orgNodeId: 'M1', name: '南昌市场' },
      { orgNodeId: 'M2', name: '九江市场' },
    ])

    await expect(listInventoryMarketTransferTargets()).resolves.toEqual([
      { orgNodeId: 'M1', name: '南昌市场' },
      { orgNodeId: 'M2', name: '九江市场' },
    ])
    const { text, params } = compile(sink.where)
    // scope 收窄在 listInventoryLocations 里是 `location_id IN (...)`；这里一个都不能有，
    // 也不能把本账号的 scope 节点当参数带进去 —— 否则 M2 会被滤掉，#340 原样复现。
    expect(text).not.toContain('"location_id" in')
    expect(params).not.toContain('N-S1')
    expect(params).not.toContain('S1')
  })

  it('只要启用的市场：is_active = true 且 location_type = 市场（停用市场、门店、总部都不出现）', async () => {
    const sink = captureSelect([])
    await listInventoryMarketTransferTargets()
    const { text, params } = compile(sink.where)
    /*
     * 整段等值，不用 toContain：「只按本账号根节点收窄」（`org_node_id = 'M1'`）这类变异
     * 不带 location_id、也不带门店节点参数，逐项 contain/not.contain 会全绿放过（#340 评审 P2-2）。
     * 条件恰好三项、参数恰好两个，多一项任何收窄都会红。
     */
    expect(text).toBe(
      '("inventory_locations"."is_active" = $1 and "inventory_locations"."location_type" = $2'
      + ' and "inventory_locations"."org_node_id" is not null)',
    )
    expect(params).toEqual(['true', '市场'])
  })

  it('越过 scope 的查询只取名称与 orgNodeId 两列', async () => {
    const sink = captureSelect([{ orgNodeId: 'M2', name: '九江市场' }])
    const rows = await listInventoryMarketTransferTargets()
    expect(Object.keys(sink.fields ?? {}).sort()).toEqual(['name', 'orgNodeId'])
    expect(Object.keys(rows[0]).sort()).toEqual(['name', 'orgNodeId'])
  })

  it('没有市场办理权限的账号被拒（含只有供应链 operate 的）', async () => {
    mockGetSession.mockResolvedValue({
      ...SINGLE_MARKET_SESSION,
      roles: [{ ...SINGLE_MARKET_SESSION.roles[0], actions: ['inventory:stock_list'] }],
      permissions: { ...SINGLE_MARKET_SESSION.permissions, actions: ['inventory:stock_list'] },
    })
    const { requireAnyPermission } = await import('@/lib/permissions')
    vi.mocked(requireAnyPermission).mockImplementationOnce(() => {
      throw new Error('PERMISSION_DENIED: 无权限')
    })
    await expect(listInventoryMarketTransferTargets()).rejects.toThrow('PERMISSION_DENIED')
    // 权限门写的是 inventoryDelegatableOperateActions('market')，'market' 必须真是这张单的层级
    const { genericDocBusinessLevel } = await import('./business-level')
    expect(genericDocBusinessLevel('市场间调货出库')).toBe('market')
    // 只认市场层 operate：供应链不能代建市场层单据，放它进来就是让建不了单的人拿全部市场名单
    expect(vi.mocked(requireAnyPermission)).toHaveBeenCalledWith(
      expect.anything(),
      ['inventory:market_operate'],
    )
    expect(mockDb.select).not.toHaveBeenCalled()
  })
})

describe('库存单据详情履约进度', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(isAdminScope).mockReturnValue(true)
    mockGetSession.mockResolvedValue(SESSION)
    mockDb.select.mockReset()
    mockDb.execute.mockReset()
  })

  it('市场报货返回可见血缘及正常、赠送发货收货进度', async () => {
    const now = new Date('2026-08-09T09:00:00.000Z')
    vi.mocked(isAdminScope).mockReturnValue(false)
    mockGetSession.mockResolvedValue({
      employeeId: 'E001',
      name: '测试用户',
      phone: '13800000000',
      roles: [{ role: 'manager', scopeId: 'MARKET-1', scopeType: '市场' }],
      permissions: { actions: ['inventory:list'], scopeStoreIds: [] },
    } as never)
    mockDb.select
      .mockReturnValueOnce(detailHeadSelect([{
        doc: {
          id: 'MBH-260809-0001',
          docType: '市场报货',
          status: '已完成',
          sourceOrgNodeId: 'MARKET-1',
          targetOrgNodeId: 'HQ',
          marketId: 'MARKET-1',
          supplierId: null,
          docDate: '2026-08-09',
          relatedSaleOrderId: null,
          customerName: null,
          employeeName: null,
          supplierName: null,
          externalPartyName: null,
          logisticsCompany: null,
          trackingNo: null,
          receiptAttachmentUrl: null,
          totalQuantity: '10',
          totalAmount: '0',
          remark: null,
          auditRemark: null,
          createdBy: 'E001',
          confirmedAt: now,
          approvedAt: null,
          rejectedAt: null,
          cancellationReason: null,
          cancelledAt: null,
          createdAt: now,
          updatedAt: now,
        },
        sourceOrgNodeName: '测试市场',
        sourceOrgNodeType: '市场',
        targetOrgNodeName: '供应链总部',
        targetOrgNodeType: '总部',
      }]))
      .mockReturnValueOnce(detailItemsSelect([{
        id: 101,
        docId: 'MBH-260809-0001',
        lotId: null,
        skuId: 'SKU-1',
        saleItemId: null,
        skuName: '测试产品',
        specName: null,
        supplier: null,
        productSeries: null,
        batchNo: '',
        expiryDate: null,
        isGift: false,
        quantity: '10',
        stockSnapshot: null,
        requestQuantity: null,
        fulfilledQuantity: '8',
        standardUnitPrice: '100',
        unitDiscount: '0',
        actualUnitPrice: '100',
        amount: '1000',
        supplyChainUnitCost: null,
        marketActualUnitPrice: '100',
        storeActualUnitPrice: null,
        reason: null,
        remark: null,
        createdAt: now,
      }]))
    mockDb.execute
      .mockResolvedValueOnce([{
        direction: '下游',
        relation_type: '市场报货采购订单',
        doc_id: 'CGD-260809-0001',
        doc_type: '采购订单',
        status: '已完成',
        // UTC 晚间仍属于上海次日，血缘单据日期必须按 Asia/Shanghai 取值。
        doc_date: new Date('2026-08-08T16:30:00.000Z'),
        total_quantity: '8',
        linked_quantity: '8',
      }])
      .mockResolvedValueOnce([{
        item_id: 101,
        normal_demand_quantity: '10',
        ordered_quantity: '8',
        normal_fulfilled_quantity: '7',
        gift_fulfilled_quantity: '2',
        normal_received_quantity: '5',
        gift_received_quantity: '1',
      }])

    const detail = await getInventoryCoreDocById('MBH-260809-0001')

    expect(detail?.lineage).toEqual([expect.objectContaining({
      direction: '下游',
      relationType: '市场报货采购订单',
      docId: 'CGD-260809-0001',
      docDate: '2026-08-09',
      linkedQuantity: 8,
    })])
    expect(detail?.fulfillmentProgress).toEqual({
      kind: '报货履约',
      items: [{
        itemId: 101,
        normalDemandQuantity: 10,
        orderedQuantity: 8,
        normalFulfilledQuantity: 7,
        giftFulfilledQuantity: 2,
        normalReceivedQuantity: 5,
        giftReceivedQuantity: 1,
      }],
    })

    const [lineageQuery, fulfillmentQuery] = mockDb.execute.mock.calls.map(([query]) => query)
    const lineageSql = renderSql(lineageQuery)
    const fulfillmentSql = renderSql(fulfillmentQuery)
    expect(lineageSql).toContain('inventory_doc_links')
    expect(sqlContains(lineageQuery, 'to_doc.source_org_node_id')).toBe(true)
    expect(sqlContains(lineageQuery, 'from_doc.target_org_node_id')).toBe(true)
    expect(fulfillmentSql).toContain('visible_docs')
    expect(sqlContains(fulfillmentQuery, 'visible_doc.source_org_node_id')).toBe(true)
    expect(fulfillmentSql).toContain('采购订单赠送发货')
    expect(fulfillmentSql).toContain("receipt_doc.status = '已完成'")
  })

  it('采购订单所有行按关联入库单聚合已收与待收数量，并带正常发货量（#335）', async () => {
    const now = new Date('2026-08-10T09:00:00.000Z')
    mockDb.select
      .mockReturnValueOnce(detailHeadSelect([{
        doc: {
          id: 'PCG-260810-0001',
          docType: '采购订单',
          status: '待收货',
          sourceOrgNodeId: null,
          targetOrgNodeId: 'HQ',
          marketId: null,
          supplierId: 'SUP-1',
          docDate: '2026-08-10',
          relatedSaleOrderId: null,
          customerName: null,
          employeeName: null,
          supplierName: '测试供应商',
          externalPartyName: null,
          logisticsCompany: null,
          trackingNo: null,
          receiptAttachmentUrl: null,
          totalQuantity: '10',
          totalAmount: '1000',
          remark: null,
          auditRemark: null,
          createdBy: 'E001',
          confirmedAt: now,
          approvedAt: null,
          rejectedAt: null,
          cancellationReason: null,
          cancelledAt: null,
          createdAt: now,
          updatedAt: now,
        },
        sourceOrgNodeName: null,
        sourceOrgNodeType: null,
        targetOrgNodeName: '供应链总部',
        targetOrgNodeType: '总部',
      }]))
      .mockReturnValueOnce(detailItemsSelect([{
        id: 201,
        docId: 'PCG-260810-0001',
        lotId: null,
        skuId: 'SKU-1',
        saleItemId: null,
        skuName: '供应链产品',
        specName: null,
        supplier: '测试供应商',
        productSeries: null,
        batchNo: '',
        expiryDate: null,
        isGift: false,
        quantity: '10',
        stockSnapshot: null,
        requestQuantity: '10',
        fulfilledQuantity: '4',
        standardUnitPrice: '100',
        unitDiscount: null,
        actualUnitPrice: '100',
        amount: '1000',
        supplyChainUnitCost: '100',
        marketActualUnitPrice: null,
        storeActualUnitPrice: null,
        reason: null,
        remark: null,
        createdAt: now,
      }]))
    mockDb.execute
      .mockResolvedValueOnce([{
        direction: '上游',
        relation_type: '品项公司报货采购订单',
        doc_id: 'ZBH-260810-0001',
        doc_type: '品项公司报货需求',
        status: '已完成',
        doc_date: '2026-08-10',
        total_quantity: '10',
        linked_quantity: '10',
      }])
      .mockResolvedValueOnce([{
        item_id: 201,
        purchased_quantity: '10',
        received_quantity: '4',
        shipped_quantity: '2',
        purchase_status: '待收货',
      }])

    const detail = await getInventoryCoreDocById('PCG-260810-0001')

    expect(detail?.lineage).toEqual([expect.objectContaining({
      direction: '上游',
      relationType: '品项公司报货采购订单',
      docId: 'ZBH-260810-0001',
    })])
    expect(detail?.fulfillmentProgress).toEqual({
      kind: '供应链采购收货',
      items: [{
        itemId: 201,
        purchasedQuantity: 10,
        receivedQuantity: 4,
        outstandingQuantity: 6,
        shippedQuantity: 2,
      }],
    })

    const [, fulfillmentQuery] = mockDb.execute.mock.calls.map(([query]) => query)
    expect(sqlContains(fulfillmentQuery, '采购订单供应链采购入库')).toBe(true)
    expect(sqlContains(fulfillmentQuery, "receipt_doc.status = '已完成'")).toBe(true)
    // 市场行同样经供应链采购入库（#335），不能再按 market_id 只统计自用行
    expect(sqlContains(fulfillmentQuery, 'market_id IS NULL')).toBe(false)
    // 发货量与 linkedQuantity 同口径：只算正常发货、排除已取消发货单
    expect(sqlContains(fulfillmentQuery, "doc_link.relation_type = '采购订单发货'")).toBe(true)
    expect(sqlContains(fulfillmentQuery, "shipment_doc.status <> '已取消'")).toBe(true)
  })

  it('已取消的品项公司发货不再显示待收数量', async () => {
    const now = new Date('2026-08-10T09:00:00.000Z')
    mockDb.select
      .mockReturnValueOnce(detailHeadSelect([{
        doc: {
          id: 'GFH-260810-0001',
          docType: '品项公司发货',
          status: '已取消',
          sourceOrgNodeId: 'HQ',
          targetOrgNodeId: 'MARKET-1',
          marketId: 'MARKET-1',
          supplierId: null,
          docDate: '2026-08-10',
          relatedSaleOrderId: null,
          customerName: null,
          employeeName: null,
          supplierName: null,
          externalPartyName: null,
          logisticsCompany: null,
          trackingNo: null,
          receiptAttachmentUrl: null,
          totalQuantity: '10',
          totalAmount: '0',
          remark: null,
          auditRemark: null,
          createdBy: 'E001',
          confirmedAt: now,
          approvedAt: null,
          rejectedAt: null,
          cancellationReason: '市场收货前发现错发',
          cancelledAt: now,
          createdAt: now,
          updatedAt: now,
        },
        sourceOrgNodeName: '供应链总部',
        sourceOrgNodeType: '总部',
        targetOrgNodeName: '测试市场',
        targetOrgNodeType: '市场',
      }]))
      .mockReturnValueOnce(detailItemsSelect([{
        id: 401,
        docId: 'GFH-260810-0001',
        lotId: 1,
        skuId: 'SKU-1',
        saleItemId: null,
        skuName: '供应链产品',
        specName: null,
        supplier: null,
        productSeries: null,
        batchNo: 'B-1',
        expiryDate: null,
        isGift: false,
        quantity: '10',
        stockSnapshot: null,
        requestQuantity: '10',
        fulfilledQuantity: '0',
        standardUnitPrice: null,
        unitDiscount: null,
        actualUnitPrice: null,
        amount: null,
        supplyChainUnitCost: null,
        marketActualUnitPrice: null,
        storeActualUnitPrice: null,
        reason: null,
        remark: null,
        createdAt: now,
      }]))
    mockDb.execute
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{
        item_id: 401,
        shipped_quantity: '10',
        received_quantity: '0',
        shipment_status: '已取消',
      }])

    const detail = await getInventoryCoreDocById('GFH-260810-0001')

    expect(detail?.fulfillmentProgress).toEqual({
      kind: '发货收货',
      items: [{
        itemId: 401,
        shippedQuantity: 10,
        receivedQuantity: 0,
        outstandingQuantity: 0,
      }],
    })
    const [, fulfillmentQuery] = mockDb.execute.mock.calls.map(([query]) => query)
    expect(sqlContains(fulfillmentQuery, 'shipment_doc.status AS shipment_status')).toBe(true)
  })

  it('品项公司报货需求按采购订单与分批入库聚合履约数量', async () => {
    const now = new Date('2026-08-10T09:00:00.000Z')
    mockDb.select
      .mockReturnValueOnce(detailHeadSelect([{
        doc: {
          id: 'ZBH-260810-0001',
          docType: '品项公司报货需求',
          status: '已完成',
          sourceOrgNodeId: null,
          targetOrgNodeId: 'HQ',
          marketId: null,
          supplierId: null,
          docDate: '2026-08-10',
          relatedSaleOrderId: null,
          customerName: null,
          employeeName: null,
          supplierName: null,
          externalPartyName: null,
          logisticsCompany: null,
          trackingNo: null,
          receiptAttachmentUrl: null,
          totalQuantity: '12',
          totalAmount: '1200',
          remark: null,
          auditRemark: null,
          createdBy: 'E001',
          confirmedAt: now,
          approvedAt: null,
          rejectedAt: null,
          cancellationReason: null,
          cancelledAt: null,
          createdAt: now,
          updatedAt: now,
        },
        sourceOrgNodeName: null,
        sourceOrgNodeType: null,
        targetOrgNodeName: '供应链总部',
        targetOrgNodeType: '总部',
      }]))
      .mockReturnValueOnce(detailItemsSelect([{
        id: 301,
        docId: 'ZBH-260810-0001',
        lotId: null,
        skuId: 'SKU-1',
        saleItemId: null,
        skuName: '供应链产品',
        specName: null,
        supplier: null,
        productSeries: null,
        batchNo: '',
        expiryDate: null,
        isGift: false,
        quantity: '12',
        stockSnapshot: null,
        requestQuantity: '12',
        fulfilledQuantity: '10',
        standardUnitPrice: '100',
        unitDiscount: null,
        actualUnitPrice: '100',
        amount: '1200',
        supplyChainUnitCost: '100',
        marketActualUnitPrice: null,
        storeActualUnitPrice: null,
        reason: null,
        remark: null,
        createdAt: now,
      }]))
    mockDb.execute
      .mockResolvedValueOnce([{
        direction: '下游',
        relation_type: '品项公司报货采购订单',
        doc_id: 'PCG-260810-0001',
        doc_type: '供应链采购订单',
        status: '待收货',
        doc_date: '2026-08-10',
        total_quantity: '10',
        linked_quantity: '10',
      }])
      .mockResolvedValueOnce([{
        item_id: 301,
        demand_quantity: '12',
        ordered_quantity: '10',
        received_quantity: '6',
      }])

    const detail = await getInventoryCoreDocById('ZBH-260810-0001')

    expect(detail?.fulfillmentProgress).toEqual({
      kind: '品项公司报货履约',
      items: [{
        itemId: 301,
        demandQuantity: 12,
        orderedQuantity: 10,
        receivedQuantity: 6,
      }],
    })

    const [, fulfillmentQuery] = mockDb.execute.mock.calls.map(([query]) => query)
    expect(sqlContains(fulfillmentQuery, '品项公司报货采购订单')).toBe(true)
    expect(sqlContains(fulfillmentQuery, '采购订单供应链采购入库')).toBe(true)
    expect(sqlContains(fulfillmentQuery, "purchase_doc.status IN ('待收货', '已完成', '已取消')")).toBe(true)
  })
})

describe('全局福利方案引擎权限', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(isAdminScope).mockReturnValue(false)
    vi.mocked(hasPermission).mockReturnValue(true)
    mockGetSession.mockResolvedValue({
      employeeId: 'E002',
      name: '市场用户',
      phone: '13800000001',
      roles: [{ role: 'manager', scopeId: 'MARKET-1', scopeType: '市场' }],
      permissions: { actions: ['inventory:market_operate', 'inventory:market_price_view'], scopeStoreIds: [] },
    })
    mockDb.select.mockReset()
    mockDb.transaction.mockReset()
  })

  it('市场用户直调引擎时不能停用全局福利方案', async () => {
    const now = new Date()
    mockDb.select
      .mockReturnValueOnce(promotionPlanSelect([{
        id: 'INV-PROMO-GLOBAL',
        planNo: 'GLOBAL-1',
        name: '全局方案',
        startsAt: '2026-01-01',
        endsAt: '2026-12-31',
        scopeMarketId: null,
        scopeMarketName: null,
        status: '启用',
        remark: null,
        createdAt: now,
        updatedAt: now,
      }]))
      .mockReturnValueOnce(promotionItemSelect([]))
    mockDb.transaction.mockImplementation(async (callback: (tx: unknown) => unknown) => callback({
      execute: vi.fn().mockResolvedValue([{ scope_market_id: null }]),
    }))

    await expect(disableInventoryPromotionPlan('INV-PROMO-GLOBAL'))
      .rejects.toThrow('市场用户不能修改或停用全局福利方案')
  })

  it('市场用户直调引擎时不能修改全局福利方案', async () => {
    const now = new Date()
    mockDb.execute.mockResolvedValue([])
    mockDb.select
      .mockReturnValueOnce(promotionPlanSelect([{
        id: 'INV-PROMO-GLOBAL',
        planNo: 'GLOBAL-1',
        name: '全局方案',
        startsAt: '2026-01-01',
        endsAt: '2026-12-31',
        scopeMarketId: null,
        scopeMarketName: null,
        status: '启用',
        remark: null,
        createdAt: now,
        updatedAt: now,
      }]))
      .mockReturnValueOnce(promotionItemSelect([]))
      .mockReturnValueOnce(selectWithLimit([{ locationType: '市场' }]))
      .mockReturnValueOnce(selectWithoutLimit([]))
      .mockReturnValueOnce(selectWithoutLimit([{ skuId: 'SKU-1' }]))
    mockDb.transaction.mockImplementation(async (callback: (tx: unknown) => unknown) => callback({
      execute: vi.fn().mockResolvedValue([{ scope_market_id: null }]),
    }))

    await expect(updateInventoryPromotionPlan('INV-PROMO-GLOBAL', {
      name: '修改后的全局方案',
      startsAt: '2026-01-01',
      endsAt: '2026-12-31',
      scopeMarketId: 'MARKET-1',
      items: [{ skuId: 'SKU-1', marketUnitDiscount: 0 }],
    })).rejects.toThrow('市场用户不能修改或停用全局福利方案')
  })
})

/**
 * 说明.md §9.4 负向矩阵：单据按实际参与主体可见——跨市场单据互不可见，
 * 总部不因父级关系自动看到市场/门店单据。断言落在单据列表的 WHERE 条件上：
 * 收紧后的 scope 之外不允许出现任何组织节点参数。
 */
describe('§9.4 单据可见范围（跨市场隔离 + 总部不下钻）', () => {
  function capturingCountSelect(rows: unknown[], sink: { where?: unknown }) {
    return {
      from: () => ({
        where: async (cond: unknown) => {
          sink.where = cond
          return rows
        },
      }),
    }
  }

  function capturingDocsListSelect(rows: unknown[], sink: { where?: unknown }) {
    return {
      from: () => ({
        leftJoin: () => ({
          leftJoin: () => ({
            where: (cond: unknown) => {
              sink.where = cond
              return { orderBy: () => ({ limit: () => ({ offset: async () => rows }) }) }
            },
          }),
        }),
      }),
    }
  }

  beforeEach(() => {
    vi.clearAllMocks()
    mockDb.select.mockReset()
    mockDb.execute.mockReset()
    vi.mocked(isAdminScope).mockReturnValue(false)
    // sync 短路：探测无漂移，聚焦 scope 条件本身。
    mockDb.execute.mockResolvedValue([{ drifted: false }] as never)
  })

  it('市场会话的单据条件仅含本市场树节点，其它市场节点绝不出现', async () => {
    mockGetSession.mockResolvedValue({
      employeeId: 'E-MKT-A',
      name: '市场A库存财务',
      phone: '13800000000',
      roles: [{
        role: 'inventory_market_finance', scopeId: 'MKT-A', scopeType: '市场',
        actions: ['inventory:list'],
        scopeStoreIds: ['STORE-A1'],
        scopeOrgNodeIds: ['MKT-A', 'NODE-A1'],
      }],
      permissions: {
        actions: ['inventory:list'],
        scopeStoreIds: ['STORE-A1'],
        scopeOrgNodeIds: ['MKT-A', 'NODE-A1'],
      },
    } as never)
    const sink: { where?: unknown } = {}
    mockDb.select
      .mockReturnValueOnce(capturingCountSelect([{ count: 0 }], sink))
      .mockReturnValueOnce(capturingDocsListSelect([], sink))

    await listInventoryCoreDocs({})

    // 双端点 OR：来源/目标任一命中本市场树才可见。
    expect(sqlContains(sink.where, 'source_org_node_id')).toBe(true)
    expect(sqlContains(sink.where, 'target_org_node_id')).toBe(true)
    expect(sqlContains(sink.where, 'MKT-A')).toBe(true)
    expect(sqlContains(sink.where, 'NODE-A1')).toBe(true)
    // 跨市场隔离：条件中不得出现其它市场的任何节点。
    expect(sqlContains(sink.where, 'MKT-B')).toBe(false)
    expect(sqlContains(sink.where, 'NODE-B1')).toBe(false)
  })

  it('总部会话的单据条件只含总部节点，不因父级关系携带市场/门店节点', async () => {
    mockGetSession.mockResolvedValue({
      employeeId: 'E-HQ',
      name: '供应链库存员',
      phone: '13800000000',
      roles: [{
        role: 'inventory_supply_chain_operator', scopeId: 'HQ-NODE', scopeType: '总部',
        actions: ['inventory:list'],
        scopeStoreIds: ['STORE-A1'],
        // 即使会话元数据带全组织树（含市场/门店后代），库存单据 scope 也只保留总部自身。
        scopeOrgNodeIds: ['HQ-NODE', 'MKT-A', 'NODE-A1'],
      }],
      permissions: {
        actions: ['inventory:list'],
        scopeStoreIds: ['STORE-A1'],
        scopeOrgNodeIds: ['HQ-NODE', 'MKT-A', 'NODE-A1'],
      },
    } as never)
    const sink: { where?: unknown } = {}
    mockDb.select
      .mockReturnValueOnce(capturingCountSelect([{ count: 0 }], sink))
      .mockReturnValueOnce(capturingDocsListSelect([], sink))

    await listInventoryCoreDocs({})

    expect(sqlContains(sink.where, 'HQ-NODE')).toBe(true)
    expect(sqlContains(sink.where, 'MKT-A')).toBe(false)
    expect(sqlContains(sink.where, 'NODE-A1')).toBe(false)
  })
})

/**
 * 说明.md §9.5 负向矩阵：价格按层级分隔，未获对应价格权限时接口不返回被遮蔽字段。
 * none 档（门店）逐字段断言无任何金额；market 档看不到供应链成本；
 * supply_chain 档看不到门店结算价。
 */
describe('§9.5 单据详情价格档位逐字段遮蔽', () => {
  const now = new Date('2026-09-01T09:00:00.000Z')

  function mockDocDetailOnce() {
    mockDb.select
      .mockReturnValueOnce(detailHeadSelect([{
        doc: {
          id: 'DTO-260901-0001',
          docType: '分院调货出库',
          status: '已完成',
          sourceOrgNodeId: 'NODE-A1',
          targetOrgNodeId: 'NODE-A2',
          marketId: 'MKT-A',
          supplierId: null,
          docDate: '2026-09-01',
          relatedSaleOrderId: null,
          customerName: null,
          employeeName: null,
          supplierName: null,
          externalPartyName: null,
          logisticsCompany: null,
          trackingNo: null,
          receiptAttachmentUrl: null,
          totalQuantity: '2',
          totalAmount: '198.00',
          remark: null,
          auditRemark: null,
          createdBy: 'E001',
          confirmedAt: null,
          approvedAt: null,
          rejectedAt: null,
          cancellationRequestReason: null,
          cancellationRequestedBy: null,
          cancellationRequestedAt: null,
          cancellationReason: null,
          cancelledAt: null,
          createdAt: now,
          updatedAt: now,
        },
        sourceOrgNodeName: '门店一',
        sourceOrgNodeType: '门店',
        targetOrgNodeName: '门店二',
        targetOrgNodeType: '门店',
      }]))
      .mockReturnValueOnce(detailItemsSelect([{
        id: 1,
        docId: 'DTO-260901-0001',
        lotId: 11,
        skuId: 'SKU-1',
        saleItemId: null,
        skuName: '测试产品',
        specName: null,
        supplier: null,
        productSeries: null,
        batchNo: 'B001',
        expiryDate: null,
        isGift: false,
        quantity: '2',
        stockSnapshot: '5',
        requestQuantity: null,
        fulfilledQuantity: null,
        standardUnitPrice: '99.00',
        unitDiscount: '1.00',
        actualUnitPrice: '98.00',
        amount: '196.00',
        supplyChainUnitCost: '30.00',
        marketActualUnitPrice: '45.00',
        storeActualUnitPrice: '66.00',
        promotionPlanId: null,
        promotionPlanNoSnapshot: null,
        promotionPlanNameSnapshot: null,
        promotionRuleTypeSnapshot: null,
        promotionSelectionMode: null,
        reason: null,
        remark: null,
        createdAt: now,
      }]))
  }

  function sessionWithActions(actions: string[], scopeOrgNodeIds: string[]) {
    return {
      employeeId: 'E-PRICE',
      name: '价格档位测试',
      phone: '13800000000',
      roles: [{
        role: 'inventory_role', scopeId: scopeOrgNodeIds[0], scopeType: '市场',
        actions,
        scopeStoreIds: [],
        scopeOrgNodeIds,
      }],
      permissions: { actions, scopeStoreIds: [], scopeOrgNodeIds },
    }
  }

  beforeEach(() => {
    vi.clearAllMocks()
    mockDb.select.mockReset()
    mockDb.execute.mockReset()
    vi.mocked(isAdminScope).mockReturnValue(false)
    // 价格档位按会话真实持有的动作判定，不再默认放行。
    vi.mocked(hasPermission).mockImplementation(
      (session, action) => (session.permissions.actions ?? []).includes(action),
    )
    mockDb.execute.mockResolvedValue([] as never)
  })

  it('none 档（门店）：单头与明细逐字段无任何金额，序列化后不出现金额键', async () => {
    mockGetSession.mockResolvedValue(sessionWithActions(
      ['inventory:list', 'inventory:store_operate'],
      ['NODE-A1'],
    ) as never)
    mockDocDetailOnce()

    const detail = await getInventoryCoreDocById('DTO-260901-0001')

    expect(detail).not.toBeNull()
    expect(detail!.totalAmount).toBeUndefined()
    const item = detail!.items[0]
    expect(item.standardUnitPrice).toBeUndefined()
    expect(item.unitDiscount).toBeUndefined()
    expect(item.actualUnitPrice).toBeUndefined()
    expect(item.amount).toBeUndefined()
    expect(item.supplyChainUnitCost).toBeUndefined()
    expect(item.marketActualUnitPrice).toBeUndefined()
    expect(item.storeActualUnitPrice).toBeUndefined()
    // 响应序列化后不允许出现任何金额键（undefined 字段会被 JSON 丢弃）。
    expect(JSON.stringify(detail)).not.toMatch(/price|amount|cost|discount/i)
  })

  it('market 档：看不到供应链成本，市场/门店结算价与金额可见', async () => {
    mockGetSession.mockResolvedValue(sessionWithActions(
      ['inventory:list', 'inventory:market_price_view'],
      ['MKT-A', 'NODE-A1', 'NODE-A2'],
    ) as never)
    mockDocDetailOnce()

    const detail = await getInventoryCoreDocById('DTO-260901-0001')

    const item = detail!.items[0]
    expect(item.supplyChainUnitCost).toBeUndefined()
    expect(item.marketActualUnitPrice).toBe(45)
    expect(item.storeActualUnitPrice).toBe(66)
    expect(item.amount).toBe(196)
    expect(detail!.totalAmount).toBe(198)
    expect(JSON.stringify(detail)).not.toMatch(/supplyChainUnitCost/)
  })

  it('supply_chain 档：可见供应成本与市场结算价，看不到门店结算价', async () => {
    // F1 行级档位后价格权只对绑定覆盖的 org 生效：绑定范围须覆盖单据端点
    // （真实会话中不覆盖端点的单据本就过不了 scope，头查询直接返回 null）。
    mockGetSession.mockResolvedValue(sessionWithActions(
      ['inventory:list', 'inventory:supply_chain_price_view'],
      ['HQ-NODE', 'NODE-A1', 'NODE-A2'],
    ) as never)
    mockDocDetailOnce()

    const detail = await getInventoryCoreDocById('DTO-260901-0001')

    const item = detail!.items[0]
    expect(item.supplyChainUnitCost).toBe(30)
    expect(item.marketActualUnitPrice).toBe(45)
    expect(item.storeActualUnitPrice).toBeUndefined()
    expect(JSON.stringify(detail)).not.toMatch(/storeActualUnitPrice/)
  })
})

/**
 * 说明.md §5.3/§10.4 回归（F2）：品项公司发货单业务响应不展示单价和货款。
 * 明细可能残留非空历史价格快照（DB 保留供入库/退货/审计追溯），响应层必须
 * 对该单据类型的所有价格/折扣/成本/金额字段整体遮蔽——即使是最高价格档位。
 */
describe('§5.3/§10.4 无金额单据类型（品项公司发货）全字段遮蔽', () => {
  const now = new Date('2026-09-01T09:00:00.000Z')

  beforeEach(() => {
    vi.clearAllMocks()
    mockDb.select.mockReset()
    mockDb.execute.mockReset()
    // admin 全量档位：连最高档也不得见无金额单据的价格快照。
    vi.mocked(isAdminScope).mockReturnValue(true)
    vi.mocked(hasPermission).mockReturnValue(true)
    mockGetSession.mockResolvedValue(SESSION)
    mockDb.execute.mockResolvedValue([] as never)
  })

  it('明细含非空历史价格快照仍被整体遮蔽（admin 档）', async () => {
    mockDb.select
      .mockReturnValueOnce(detailHeadSelect([{
        doc: {
          id: 'GFH-260901-0001',
          docType: '品项公司发货',
          status: '待收货',
          sourceOrgNodeId: 'HQ',
          targetOrgNodeId: 'MKT-A',
          marketId: 'MKT-A',
          supplierId: null,
          docDate: '2026-09-01',
          relatedSaleOrderId: null,
          customerName: null,
          employeeName: null,
          supplierName: null,
          externalPartyName: null,
          logisticsCompany: null,
          trackingNo: null,
          receiptAttachmentUrl: null,
          totalQuantity: '8',
          totalAmount: '0.00',
          remark: null,
          auditRemark: null,
          createdBy: 'E001',
          confirmedAt: now,
          approvedAt: null,
          rejectedAt: null,
          cancellationRequestReason: null,
          cancellationRequestedBy: null,
          cancellationRequestedAt: null,
          cancellationReason: null,
          cancelledAt: null,
          createdAt: now,
          updatedAt: now,
        },
        sourceOrgNodeName: '供应链总部',
        sourceOrgNodeType: '总部',
        targetOrgNodeName: '市场A',
        targetOrgNodeType: '市场',
      }]))
      .mockReturnValueOnce(detailItemsSelect([{
        id: 1,
        docId: 'GFH-260901-0001',
        lotId: 11,
        skuId: 'SKU-1',
        saleItemId: null,
        skuName: '供应链产品',
        specName: null,
        supplier: null,
        productSeries: null,
        batchNo: 'B001',
        expiryDate: null,
        isGift: false,
        quantity: '8',
        stockSnapshot: null,
        requestQuantity: '6',
        fulfilledQuantity: '0',
        // 非空历史价格快照：一律不得进入业务响应。
        standardUnitPrice: '1000.00',
        unitDiscount: '50.00',
        actualUnitPrice: '950.00',
        amount: '0.00',
        supplyChainUnitCost: '800.00',
        marketActualUnitPrice: '950.00',
        storeActualUnitPrice: '1200.00',
        promotionPlanId: null,
        promotionPlanNoSnapshot: null,
        promotionPlanNameSnapshot: null,
        promotionRuleTypeSnapshot: null,
        promotionSelectionMode: null,
        reason: null,
        remark: null,
        createdAt: now,
      }]))

    const detail = await getInventoryCoreDocById('GFH-260901-0001')

    expect(detail).not.toBeNull()
    expect(detail!.totalAmount).toBeUndefined()
    const item = detail!.items[0]
    expect(item.standardUnitPrice).toBeUndefined()
    expect(item.unitDiscount).toBeUndefined()
    expect(item.actualUnitPrice).toBeUndefined()
    expect(item.amount).toBeUndefined()
    expect(item.supplyChainUnitCost).toBeUndefined()
    expect(item.marketActualUnitPrice).toBeUndefined()
    expect(item.storeActualUnitPrice).toBeUndefined()
    // 数量/进度字段照常返回。
    expect(item.quantity).toBe(8)
    expect(item.requestQuantity).toBe(6)
  })
})

/**
 * 说明.md §9.3 回归（F1 跨绑定价格泄漏）：一次会话持有多条角色绑定时，
 * 价格权限只对授予它的那条绑定覆盖的 org 生效。失败场景：账号在市场 B 绑
 * inventory_market_finance（含 market_price_view）、在门店 A 绑
 * inventory_store_operator，读门店 A 单据时不得借市场 B 的价格权看到金额。
 */
describe('§9.3 混合绑定行级价格档位（跨绑定借权回归）', () => {
  const now = new Date('2026-09-01T09:00:00.000Z')

  const MIXED_SESSION = {
    employeeId: 'E-MIX',
    name: '混合绑定员工',
    phone: '13800000001',
    roles: [{
      role: 'inventory_market_finance', scopeId: 'MKT-B', scopeType: '市场',
      actions: ['inventory:list', 'inventory:stock_list', 'inventory:market_price_view'],
      scopeStoreIds: ['STORE-B1'],
      scopeOrgNodeIds: ['MKT-B', 'NODE-B1'],
    }, {
      role: 'inventory_store_operator', scopeId: 'NODE-A1', scopeType: '门店',
      actions: ['inventory:list', 'inventory:stock_list', 'inventory:store_operate'],
      scopeStoreIds: ['STORE-A1'],
      scopeOrgNodeIds: ['NODE-A1'],
    }],
    permissions: {
      actions: ['inventory:list', 'inventory:stock_list', 'inventory:market_price_view', 'inventory:store_operate'],
      scopeStoreIds: ['STORE-B1', 'STORE-A1'],
      scopeOrgNodeIds: ['MKT-B', 'NODE-B1', 'NODE-A1'],
    },
  } as never

  function docFixture(id: string, sourceOrgNodeId: string, targetOrgNodeId: string) {
    return {
      doc: {
        id,
        docType: '分院调货出库',
        status: '已完成',
        sourceOrgNodeId,
        targetOrgNodeId,
        marketId: 'MKT-X',
        supplierId: null,
        docDate: '2026-09-01',
        relatedSaleOrderId: null,
        customerName: null,
        employeeName: null,
        supplierName: null,
        externalPartyName: null,
        logisticsCompany: null,
        trackingNo: null,
        receiptAttachmentUrl: null,
        totalQuantity: '2',
        totalAmount: '198.00',
        remark: null,
        auditRemark: null,
        createdBy: 'E001',
        confirmedAt: null,
        approvedAt: null,
        rejectedAt: null,
        cancellationRequestReason: null,
        cancellationRequestedBy: null,
        cancellationRequestedAt: null,
        cancellationReason: null,
        cancelledAt: null,
        createdAt: now,
        updatedAt: now,
      },
      sourceOrgNodeName: '来源',
      sourceOrgNodeType: '门店',
      targetOrgNodeName: '目标',
      targetOrgNodeType: '门店',
    }
  }

  function itemFixture(docId: string) {
    return {
      id: 1,
      docId,
      lotId: 11,
      skuId: 'SKU-1',
      saleItemId: null,
      skuName: '测试产品',
      specName: null,
      supplier: null,
      productSeries: null,
      batchNo: 'B001',
      expiryDate: null,
      isGift: false,
      quantity: '2',
      stockSnapshot: '5',
      requestQuantity: null,
      fulfilledQuantity: null,
      standardUnitPrice: '99.00',
      unitDiscount: '1.00',
      actualUnitPrice: '98.00',
      amount: '196.00',
      supplyChainUnitCost: '30.00',
      marketActualUnitPrice: '45.00',
      storeActualUnitPrice: '66.00',
      promotionPlanId: null,
      promotionPlanNoSnapshot: null,
      promotionPlanNameSnapshot: null,
      promotionRuleTypeSnapshot: null,
      promotionSelectionMode: null,
      reason: null,
      remark: null,
      createdAt: now,
    }
  }

  beforeEach(() => {
    vi.clearAllMocks()
    mockDb.select.mockReset()
    mockDb.execute.mockReset()
    vi.mocked(isAdminScope).mockReturnValue(false)
    vi.mocked(hasPermission).mockImplementation(
      (session, action) => (session.permissions.actions ?? []).includes(action),
    )
    mockDb.execute.mockResolvedValue([] as never)
    mockGetSession.mockResolvedValue(MIXED_SESSION)
  })

  it('读门店 A 单据：不得借市场 B 的价格权，逐金额字段 undefined', async () => {
    mockDb.select
      .mockReturnValueOnce(detailHeadSelect([docFixture('DTO-260901-0001', 'NODE-A1', 'NODE-A2')]))
      .mockReturnValueOnce(detailItemsSelect([itemFixture('DTO-260901-0001')]))

    const detail = await getInventoryCoreDocById('DTO-260901-0001')

    expect(detail).not.toBeNull()
    expect(detail!.totalAmount).toBeUndefined()
    const item = detail!.items[0]
    expect(item.standardUnitPrice).toBeUndefined()
    expect(item.unitDiscount).toBeUndefined()
    expect(item.actualUnitPrice).toBeUndefined()
    expect(item.amount).toBeUndefined()
    expect(item.supplyChainUnitCost).toBeUndefined()
    expect(item.marketActualUnitPrice).toBeUndefined()
    expect(item.storeActualUnitPrice).toBeUndefined()
    expect(JSON.stringify(detail)).not.toMatch(/price|amount|cost|discount/i)
  })

  it('同一会话读市场 B 自己的单据：市场档金额照常返回', async () => {
    mockDb.select
      .mockReturnValueOnce(detailHeadSelect([docFixture('DTO-260901-0002', 'NODE-B1', 'MKT-B')]))
      .mockReturnValueOnce(detailItemsSelect([itemFixture('DTO-260901-0002')]))

    const detail = await getInventoryCoreDocById('DTO-260901-0002')

    expect(detail!.totalAmount).toBe(198)
    const item = detail!.items[0]
    expect(item.amount).toBe(196)
    expect(item.marketActualUnitPrice).toBe(45)
    expect(item.storeActualUnitPrice).toBe(66)
    // 市场档依旧看不到供应链成本。
    expect(item.supplyChainUnitCost).toBeUndefined()
  })

  it('单据列表按行遮蔽：门店 A 行无金额、市场 B 行有金额', async () => {
    const countSelect = { from: () => ({ where: async () => [{ count: 2 }] }) }
    const listSelect = {
      from: () => ({
        leftJoin: () => ({
          leftJoin: () => ({
            where: () => ({
              orderBy: () => ({
                limit: () => ({
                  offset: async () => [
                    docFixture('DTO-260901-0001', 'NODE-A1', 'NODE-A2'),
                    docFixture('DTO-260901-0002', 'NODE-B1', 'MKT-B'),
                  ],
                }),
              }),
            }),
          }),
        }),
      }),
    }
    mockDb.select
      .mockReturnValueOnce(countSelect as never)
      .mockReturnValueOnce(listSelect as never)

    const result = await listInventoryCoreDocs({})

    expect(result.data).toHaveLength(2)
    expect(result.data[0].totalAmount).toBeUndefined()
    expect(result.data[1].totalAmount).toBe(198)
  })

  it('库存批次按 location 归属 org 行级遮蔽：门店 A 批次无价、市场 B 批次有价', async () => {
    function stockLot(id: number, locationId: string) {
      return {
        lot: {
          id,
          locationId,
          skuId: 'SKU-1',
          skuName: '测试产品',
          specName: null,
          supplier: null,
          productSeries: null,
          batchNo: 'B001',
          expiryDate: null,
          isGift: false,
          quantityOnHand: '5',
          supplyChainUnitCost: '30.00',
          marketActualUnitPrice: '45.00',
          storeActualUnitPrice: '66.00',
          remark: null,
          updatedAt: now,
        },
        locationName: locationId,
        locationType: '门店',
        locationOrgNodeId: locationId === 'STORE-A1' ? 'NODE-A1' : 'NODE-B1',
        reservedQuantity: '1',
      }
    }
    const countSelect = { from: () => ({ leftJoin: () => ({ where: async () => [{ count: 2 }] }) }) }
    const listSelect = {
      from: () => ({
        leftJoin: () => ({
          where: () => ({
            orderBy: () => ({
              limit: () => ({
                offset: async () => [stockLot(1, 'STORE-A1'), stockLot(2, 'STORE-B1')],
              }),
            }),
          }),
        }),
      }),
    }
    mockDb.select
      .mockReturnValueOnce(countSelect as never)
      .mockReturnValueOnce(listSelect as never)

    const result = await listInventoryLots({})

    const [storeALot, storeBLot] = result.data
    expect(storeALot.availableQuantity).toBe(4)
    expect(storeALot.supplyChainUnitCost).toBeUndefined()
    expect(storeALot.marketActualUnitPrice).toBeUndefined()
    expect(storeALot.storeActualUnitPrice).toBeUndefined()
    expect(storeBLot.marketActualUnitPrice).toBe(45)
    expect(storeBLot.storeActualUnitPrice).toBe(66)
    expect(storeBLot.supplyChainUnitCost).toBeUndefined()
  })

  it('可用量口径：预留扣减子查询含「已预留」状态与 fulfilled/released 差额表达式', async () => {
    const countSelect = { from: () => ({ leftJoin: () => ({ where: async () => [{ count: 0 }] }) }) }
    const listSelect = {
      from: () => ({
        leftJoin: () => ({
          where: () => ({
            orderBy: () => ({ limit: () => ({ offset: async () => [] }) }),
          }),
        }),
      }),
    }
    let capturedFields: Record<string, unknown> | undefined
    mockDb.select
      .mockReturnValueOnce(countSelect as never)
      .mockImplementationOnce(((fields: Record<string, unknown>) => {
        capturedFields = fields
        return listSelect
      }) as never)

    await listInventoryLots({})

    // 断言 engine 实际生成的预留标量子查询：与 pickup-records 的 GREATEST 口径一致，
    // 未完成预留 = 已预留状态的 quantity − fulfilled − released。
    const reservedSql = renderSql(capturedFields?.reservedQuantity)
    expect(reservedSql).toContain('inventory_stock_reservations')
    expect(reservedSql).toContain("reservation.status = '已预留'")
    expect(reservedSql).toContain('reservation.quantity - reservation.fulfilled_quantity - reservation.released_quantity')
  })
})

// ── 盘点单账面数量（#131）────────────────────────────────────────────────
// 盘点单没有批次选择器，`lot` 恒为 null，原实现 `stockSnapshot: lot ? … : null` 让
// `stock_snapshot` 恒 NULL —— 盘点单退化成一张只有「实盘数」的白条，无法用于任何盈亏对账。
// 口径（甲方 2026-09-16 拍板）：账面数按**主体 + SKU 汇总**、取**在手量不扣预留**。

/**
 * 按 SQL 文本路由的 tx.execute —— 比「按调用顺序排 mockResolvedValueOnce」抗漂移：
 * 中间多一条无关查询不会让整串错位。返回值之外还把渲染后的 SQL 收集起来供断言。
 */
function routingTxExecute(routes: Array<[string, unknown]>) {
  const calls: string[] = []
  const fn = vi.fn(async (query: unknown) => {
    const rendered = renderSql(query)
    calls.push(rendered)
    for (const [fragment, rows] of routes) {
      if (rendered.includes(fragment)) return rows
    }
    return []
  })
  return { fn, calls }
}

describe('盘点单账面数量（#131）', () => {
  /**
   * `db.select().from(表)` 也是一条读通道 —— 在事务回调里读 `inventory_stock_reservations`
   * 再在 JS 里扣掉预留，主查询 SQL 一字不变、`executedSql` 也看不见（它不走 execute）。
   * 这里把 `.from()` 的表参数记下来，并入下面的「不该碰预留表」断言。
   */
  const selectedTables: unknown[] = []
  const recordingSelect = (rows: unknown[]) => ({
    from: (table: unknown) => {
      selectedTables.push(tableName(table))
      return { where: () => ({ limit: async () => rows }) }
    },
  })

  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(isAdminScope).mockReturnValue(true)
    mockGetSession.mockResolvedValue(SESSION)
    mockDb.execute.mockResolvedValue([])
    mockDb.select.mockReset()
    // locationId 刻意与 orgNodeId 取不同的值：账面数查询必须按**库存主体**过滤，
    // 传成 orgNodeId 的话断言要能看出来（ensureOrgNodeLocation 有 `locationId ?? orgNodeId` 兜底）
    selectedTables.length = 0
    mockDb.select.mockImplementation(() =>
      recordingSelect([{ locationId: 'LOC-MARKET-1', locationType: '市场' }]))
    mockDb.transaction.mockReset()
    // 非事务 query builder 也配好返回链：否则「误用 db.update(...) 改库存」那类回归
    // 会因 `undefined.set` 抛 TypeError 而变红 —— 那是**偶发红**，不是设计的守护。
    // 配好之后，红的必须是 writtenTables 那条断言本身。
    mockDb.insert.mockReturnValue({ values: vi.fn(() => ({ returning: vi.fn().mockResolvedValue([{ id: 1 }]) })) })
    mockDb.update.mockReturnValue({ set: vi.fn(() => ({ where: vi.fn().mockResolvedValue(undefined) })) })
    mockDb.delete.mockReturnValue({ where: vi.fn().mockResolvedValue(undefined) })
  })

  const SKU_SNAPSHOT_ROW = {
    sku_id: 'SKU-1',
    product_name: '测试 SKU',
    spec_name: null,
    supplier: null,
    product_series: null,
    source_type: '供应链',
    owner_market_id: null,
  }

  /**
   * 盘点建单场景。`bookBySku` 是「账面数查询要返回哪些行」——注意查询是一次
   * `GROUP BY sku_id`，所以返回的是**行数组**，没查到的 SKU 天然不在结果里。
   */
  function setupStocktake(bookBySku: Record<string, string>) {
    const { fn: txExecute, calls } = routingTxExecute([
      [
        'SUM(quantity_on_hand)',
        Object.entries(bookBySku).map(([sku_id, quantity]) => ({ sku_id, quantity })),
      ],
      ['FROM inventory_skus', [SKU_SNAPSHOT_ROW]],
    ])
    const headerValues = vi.fn().mockResolvedValue(undefined)
    const itemValues = vi.fn((_values: Record<string, unknown>) => ({
      returning: vi.fn().mockResolvedValue([{ id: 1 }]),
    }))
    // 记录 table 入参：用表名断言比按 SQL 字面量匹配抗漂移（带引号/大小写/表对象插值都能认）
    let insertCall = 0
    const txInsert = vi.fn((_table: unknown) => (
      insertCall++ === 0 ? { values: headerValues } : { values: itemValues }
    ))
    const txUpdate = vi.fn((_table: unknown) => ({ set: vi.fn(() => ({ where: vi.fn().mockResolvedValue(undefined) })) }))
    // ⚠️ delete / select 也要**配好返回链**并记账：不配的话这两条通道的回归是靠
    //    `undefined.where` 抛 TypeError 变红的「偶发红」，谁顺手照 update 的样子把 mock
    //    补上（本仓 `engine.ts` 里 `.delete()` 是真实写入形态），回归立刻静默漏检。
    const txDelete = vi.fn((_table: unknown) => ({ where: vi.fn().mockResolvedValue(undefined) }))
    const txSelect = vi.fn(() => recordingSelect([]))
    mockDb.transaction.mockImplementation(async (callback: (tx: unknown) => unknown) => callback({
      execute: initializedCutoverExecutor(txExecute),
      insert: txInsert,
      update: txUpdate,
      delete: txDelete,
      select: txSelect,
    }))
    return { calls, headerValues, itemValues, txExecute, txUpdate, txInsert, txDelete }
  }

  /** 取账面数查询的原始 query 对象（要看绑定参数只能深走对象图，见下方注释）。 */
  function bookQuery(txExecute: { mock: { calls: unknown[][] } }): unknown {
    return txExecute.mock.calls
      .map((args) => args[0])
      .find((query) => renderSql(query).includes('SUM(quantity_on_hand)'))
  }

  /**
   * 用 drizzle **自己的编译器**把 query 编成真正发给 PG 的 `{ sql, params }`。
   *
   * 为什么不手写遍历 `queryChunks`：试过三版，每版都被评审找出漏洞 ——
   * 裸数组 chunk / `sql.param(arr)` 的数组型 Param / `db.select().as()` 子查询里
   * 藏在 `getSQL()` 的 SQL，载体各不相同；而「什么都遍历」那版又会在读
   * query-builder 代理的任意属性时抛错，把**正确实现判红**。
   * 编译器是唯一权威：它输出什么，PG 就收到什么，所有形态自然都覆盖到。
   *
   * 本次要守的两件事，编译后都是一眼可判的：
   *   - SKU 列表必须逐个参数化成 `IN ($1, $2)`。
   *     `IN (${arr})` → `IN (($1, $2))`（PG 当 record 解析，报错）；
   *     `ANY(${arr}::text[])` → `ANY(($1, $2)::text[])`（同样报错）；
   *     `ANY(${sql.param(arr)}::text[])` → `ANY($1::text[])` 且 **params 里是数组**
   *     → postgres.js 串成 `SKU-1,SKU-2` → `22P02 malformed array literal`。
   *     三种本 issue 都实机踩过或实测复现过。
   *   - 账面数**不扣预留**（#131 Q0）：编译后的 SQL 文本里不该出现 reservation，
   *     无论它是内联 CTE、嵌套 `sql` 对象还是子查询。
   */
  function compileSql(query: unknown): { text: string; params: unknown[] } {
    const compiled = new PgDialect().sqlToQuery(query as Parameters<PgDialect['sqlToQuery']>[0])
    return { text: compiled.sql, params: compiled.params }
  }

  /**
   * 这条 SQL 是否**写**了某张表（INSERT / UPDATE / DELETE）。
   *
   * ⚠️ 别退回 `calls.some(c => c.includes('INSERT INTO inventory_movements'))` 那种字面匹配：
   *   - `INSERT INTO "inventory_movements"`（带引号）、`insert into …`（小写）都匹配不上；
   *   - `sql\`UPDATE ${inventoryStockLots} …\`` 经顶层 renderSql 会渲成 `UPDATE [object Object]`。
   * 这里统一走**编译产物**（表对象会被解析成真实表名）+ 归一大小写与引号。
   */
  function writesTable(sqlText: string, table: string): boolean {
    const normalized = sqlText
      .toLowerCase()
      .replace(/\/\*[\s\S]*?\*\//g, ' ')   // 块注释：`UPDATE /* 盘点自动校准 */ tbl` 是合法 SQL
      .replace(/--[^\n]*/g, ' ')            // 行注释
      .replace(/["`]/g, '')
    // `\\w+\\.` 是 schema 限定名：`INSERT INTO public.inventory_movements` /
    // drizzle 编译出的 `"public"."inventory_movements"` 去引号后都是这个形态，
    // 不放行的话这一整类写法静默漏检。
    return new RegExp(`(insert\\s+into|update(\\s+only)?|delete\\s+from|merge\\s+into|truncate(\\s+table)?)\\s+(\\w+\\.)?${table}\\b`).test(normalized)
  }

  /** 事务里所有 tx.execute 的**编译后**文本 */
  function executedSql(txExecute: { mock: { calls: unknown[][] } }): string[] {
    return txExecute.mock.calls.map((args) => {
      try { return compileSql(args[0]).text } catch { return String(args[0]) }
    })
  }

  /**
   * drizzle 表对象 → 真实表名。
   *
   * ⚠️ `alias(tbl, 'x')` 之后 `drizzle:Name` 变成别名 `x`，原表名只在 `drizzle:OriginalName`。
   * 只读前者的话，`db.select().from(alias(inventoryStockReservations,'r'))` 就记不到真实表名。
   */
  function tableName(table: unknown): unknown {
    const t = table as Record<symbol, unknown> | null | undefined
    return t?.[Symbol.for('drizzle:OriginalName')] ?? t?.[Symbol.for('drizzle:Name')]
  }

  it('市场库存盘点把主体 + SKU 的在手量写进 stock_snapshot', async () => {
    const { itemValues, txExecute } = setupStocktake({ 'SKU-1': '12' })

    await createInventoryCoreDoc({
      docType: '市场库存盘点',
      sourceOrgNodeId: 'MARKET-1',
      items: [{ skuId: 'SKU-1', quantity: 9 }],
    } as never)

    expect(itemValues).toHaveBeenCalledWith(expect.objectContaining({
      // 账面 12、实盘 9 —— 差异由前端算，不落库
      stockSnapshot: '12',
      quantity: '9',
      lotId: null,
    }))
    // 账面数必须按「这个主体 + 这些 SKU」聚合。
    // ⚠️ 不能只断模板文本含 'location_id' / 'sku_id'：绑定参数不在模板文本里，
    //    把 actingLocationId 误传成别的主体、或传成上一行的 skuId，那种断言照样绿。
    //    这里直接断**编译后真正发给 PG 的参数**。
    const { text, params } = compileSql(bookQuery(txExecute))
    expect(text).toContain('GROUP BY sku_id')
    expect(params, '账面数查询的主体或 SKU 传错了').toEqual(['LOC-MARKET-1', 'SKU-1'])
  })

  it('分院库存盘点同样写账面数', async () => {
    mockDb.select.mockImplementation(() =>
      recordingSelect([{ locationId: 'LOC-STORE-1', locationType: '门店' }]))
    const { itemValues } = setupStocktake({ 'SKU-1': '3' })

    await createInventoryCoreDoc({
      docType: '分院库存盘点',
      sourceOrgNodeId: 'STORE-1',
      items: [{ skuId: 'SKU-1', quantity: 3 }],
    } as never)

    expect(itemValues).toHaveBeenCalledWith(expect.objectContaining({ stockSnapshot: '3' }))
  })

  it('该 SKU 在该主体一个批次都没有时账面数是 0，不是 NULL', async () => {
    // GROUP BY 查不到该 SKU 就不出行。落 0 表示「账上就是 0」；若退化成 NULL，
    // 前端差异列会显示「—」（当成历史单没记账面），而不是「账上 0、实盘 5 = 盘盈 5」。
    const { itemValues } = setupStocktake({})

    await createInventoryCoreDoc({
      docType: '市场库存盘点',
      sourceOrgNodeId: 'MARKET-1',
      items: [{ skuId: 'SKU-1', quantity: 5 }],
    } as never)

    expect(itemValues).toHaveBeenCalledWith(expect.objectContaining({ stockSnapshot: '0' }))
  })

  it('numeric 的小数与末尾零归一后落库', async () => {
    // pg 的 numeric 经 postgres.js 回来是 string（'7.50'）。经 Number → numString
    // 归一成 '7.5' 再落 numeric(12,2)。这条钉的是**小数不被截断、末尾零被归一**，
    // 不宣称守护类型转换本身 —— numString 自己就是 String(Number(v))，
    // 把上游的 Number() 删掉这条照样绿，不该假装它守得住。
    const { itemValues } = setupStocktake({ 'SKU-1': '7.50' })

    await createInventoryCoreDoc({
      docType: '市场库存盘点',
      sourceOrgNodeId: 'MARKET-1',
      items: [{ skuId: 'SKU-1', quantity: 7 }],
    } as never)

    expect(itemValues).toHaveBeenCalledWith(expect.objectContaining({ stockSnapshot: '7.5' }))
  })

  it('非盘点单不受影响：入库类仍写批次在手量，且不跑账面数聚合', async () => {
    // ⚠️ 经核实，通用建单的 10 种类型里**只有两种盘点单会走「无批次」分支**，
    //    所以「非盘点单 + 无批次 → stock_snapshot 为 null」这个场景根本不可达。
    //    真正该守的是：入库类走 ensureLotFromSku，快照取**批次**在手量，且不跑盘点聚合。
    const { fn: txExecute, calls } = routingTxExecute([
      ['INSERT INTO inventory_stock_lots', [{ id: 7 }]],
      ['FOR UPDATE', [{ ...lotRow('99'), id: 7 }]],
      ['FROM inventory_skus', [SKU_SNAPSHOT_ROW]],
    ])
    const itemValues = vi.fn((_values: Record<string, unknown>) => ({
      returning: vi.fn().mockResolvedValue([{ id: 1 }]),
    }))
    const txInsert = vi.fn()
      .mockReturnValueOnce({ values: vi.fn().mockResolvedValue(undefined) })
      .mockReturnValue({ values: itemValues })
    mockDb.transaction.mockImplementation(async (callback: (tx: unknown) => unknown) => callback({
      execute: initializedCutoverExecutor(txExecute),
      insert: txInsert,
      update: vi.fn(() => ({ set: vi.fn(() => ({ where: vi.fn().mockResolvedValue(undefined) })) })),
    }))

    await createInventoryCoreDoc({
      docType: '市场产品盘溢',
      targetOrgNodeId: 'MARKET-1',
      items: [{ skuId: 'SKU-1', quantity: 1 }],
    } as never)

    // 无条件断言（原版用 .catch 吞异常 + if 包住断言，标题主张一个字都没断到）
    expect(itemValues).toHaveBeenCalledWith(expect.objectContaining({
      stockSnapshot: '99',
      lotId: 7,
    }))
    expect(calls.some((c) => c.includes('SUM(quantity_on_hand)'))).toBe(false)
  })

  // ⚠️ 两种盘点类型都要跑：只测市场的话，「只在分院分支里新增 INSERT INTO inventory_movements」
  //    这种回归在 admin 侧完全没有守卫（分院用例只断了 stockSnapshot 的值）。
  it.each([
    ['市场库存盘点', 'MARKET-1', 'LOC-MARKET-1', '市场'],
    ['分院库存盘点', 'STORE-1', 'LOC-STORE-1', '门店'],
  ])('%s 不产生库存流水，也不直接改在手量', async (docType, orgNodeId, locationId, locationType) => {
    mockDb.select.mockImplementation(() => recordingSelect([{ locationId, locationType }]))
    const { txExecute, txUpdate, txInsert, txDelete } = setupStocktake({ 'SKU-1': '12' })

    await createInventoryCoreDoc({
      docType,
      sourceOrgNodeId: orgNodeId,
      items: [{ skuId: 'SKU-1', quantity: 9 }],
    } as never)

    // 验收标准原文是「不产生任何 inventory_movements **且**不改变 quantity_on_hand」。
    // 两条都要守，因为改在手量有**两条**路径：
    //   1. 写流水 → migration 0009 的触发器联动更新 quantity_on_hand（当前唯一路径）
    //   2. 直接写 inventory_stock_lots（当前代码里没有，但「盘点自动校准」这类需求
    //      最可能就从这里来，且它不写流水 —— 只断第 1 条会完全看不见）
    // 所有写入通道合并成**一个表集合**再判。
    // ⚠️ 别按通道分别断「tx.insert 的调用序列等于 [...]」——那绑的是 ORM 调用形态，
    //    把单头 INSERT 等价改写成原生 SQL 就会误红，而落库结果完全没变。
    //    这里只关心「写了哪些表」这个语义事实。
    // ⚠️ **非事务**通道也要扫：在事务回调里误写 `db.execute(...)` / `db.update(...)` 之类，
    //    既真改库存（事务外执行、不随回滚撤销）、又违反「单事务体内不得非-tx await」，
    //    只扫 tx.* 完全看不见。
    const ALL_TABLES = [
      'inventory_docs', 'inventory_doc_items', 'inventory_movements',
      'inventory_stock_lots', 'inventory_stock_reservations', 'inventory_doc_links',
    ]
    const allSql = [...executedSql(txExecute), ...executedSql(mockDb.execute)]
    const writtenTables = new Set<unknown>([
      ...txInsert.mock.calls.map(([t]) => tableName(t)),
      ...txUpdate.mock.calls.map(([t]) => tableName(t)),
      // 非事务 query builder（本仓真实存在的写入形态，本文件多处既有用例就在配它的返回链）
      ...txDelete.mock.calls.map(([t]) => tableName(t)),
      ...mockDb.insert.mock.calls.map(([t]: unknown[]) => tableName(t)),
      ...mockDb.update.mock.calls.map(([t]: unknown[]) => tableName(t)),
      ...mockDb.delete.mock.calls.map(([t]: unknown[]) => tableName(t)),
      ...ALL_TABLES.filter((t) => allSql.some((text) => writesTable(text, t))),
    ])
    // 反向：绝不能碰流水与批次表（改在手量的两条路都在这里）
    expect([...writtenTables], '盘点写了库存流水').not.toContain('inventory_movements')
    expect([...writtenTables], '盘点直接改了批次表').not.toContain('inventory_stock_lots')
    // 正向：建单只该写单头与明细
    expect([...writtenTables].sort()).toEqual(['inventory_doc_items', 'inventory_docs'])
    // 账面数**不扣预留**（#131 Q0）：整个建单过程连预留表都不该碰。
    // ⚠️ 只断主查询 SQL 里没有 reserv 是不够的 —— 保留主查询、**另发一条**查预留的
    //    SELECT 再在 JS 里减掉，主查询快照一字不变，那条断言照样绿。
    // 读通道也一并判：原生 SQL 与 `db.select().from(预留表)` 两条路都不该出现
    expect(allSql.some((text) => /inventory_stock_reservations/i.test(text)), '盘点期间用 SQL 查了预留表 —— 账面数不该扣预留').toBe(false)
    expect(selectedTables, '盘点期间用 db.select 读了预留表 —— 账面数不该扣预留')
      .not.toContain('inventory_stock_reservations')
  })

  it('同一 SKU 在一张盘点单里只能出现一次，且在开事务前就拦住', async () => {
    // 账面数按「主体 + SKU 汇总」记，两行同 SKU 会各自拿到**同一个**完整账面数，
    // 差异列直接变成重复计算的废数 —— 必须在建单时就拦住。
    const { itemValues, headerValues } = setupStocktake({ 'SKU-1': '12' })

    await expect(createInventoryCoreDoc({
      docType: '市场库存盘点',
      sourceOrgNodeId: 'MARKET-1',
      items: [
        { skuId: 'SKU-1', quantity: 9 },
        { skuId: 'SKU-1', quantity: 3 },
      ],
    } as never)).rejects.toThrow('同一 SKU 请合并为一条盘点明细')

    // 拦在**开事务之前**：直接断 db.transaction 一次都没调用。
    // ⚠️ 只断「没插单头/明细」不够 —— 把校验挪到事务内、cutover 加锁之后、插单头之前，
    //    这两条仍然 not.toHaveBeenCalled，而重复请求已经拿到了全库存域的 FOR UPDATE 锁。
    expect(mockDb.transaction, '重复行校验没有拦在开事务之前').not.toHaveBeenCalled()
    expect(headerValues).not.toHaveBeenCalled()
    expect(itemValues).not.toHaveBeenCalled()
  })

  it('不同 SKU 的多行盘点：一次查询取齐，各行带各自的账面数', async () => {
    const { itemValues, txExecute, calls } = setupStocktake({ 'SKU-1': '12', 'SKU-2': '4' })

    await createInventoryCoreDoc({
      docType: '市场库存盘点',
      sourceOrgNodeId: 'MARKET-1',
      items: [
        { skuId: 'SKU-1', quantity: 9 },
        { skuId: 'SKU-2', quantity: 4 },
      ],
    } as never)

    expect(itemValues).toHaveBeenCalledTimes(2)
    expect(itemValues.mock.calls[0][0]).toMatchObject({ stockSnapshot: '12', quantity: '9' })
    expect(itemValues.mock.calls[1][0]).toMatchObject({ stockSnapshot: '4', quantity: '4' })

    // **N+1 回归守护**：建单事务全程持有 inventory_cutover_states 的行锁（全库存域串行点），
    // 逐行查会把别人的库存写入一起堵住。两行明细也只能发一次账面数查询。
    expect(calls.filter((c) => c.includes('SUM(quantity_on_hand)'))).toHaveLength(1)

    // ── 账面数查询的**口径快照** ─────────────────────────────────────
    // 断的是 drizzle 编译后真正发给 PG 的 `{sql, params}`（见 compileSql 的注释）。
    //
    // 为什么整条快照、而不是挑几个片段断：挑片段挡不住「多加一个过滤条件」。
    // 比如补一句 `AND (expiry_date IS NULL OR expiry_date >= CURRENT_DATE)`，
    // 账面数就会漏掉已过期但仍在手的批次、比实际偏小 —— 而「含 IN ($2,$3)」
    // 「参数是这三个」「不含 reserv」三条断言全都照样绿。
    //
    // 口径是甲方拍板的（#131 Q0 在手量不扣预留 / Q1 按主体 + SKU 汇总**全部批次**），
    // 所以这条查询任何改动都应该是**有意**的：改了就来更新这份快照，顺便重新想一遍口径。
    // ⚠️ 代价是它对**书写形式**也敏感：调换 WHERE 顺序、或在 SKU 列表前插入新的绑定参数
    //    （占位符会从 $2/$3 顺延），都会让这条红 —— 那是刻意的，不是缺陷，照着新编译结果更新即可。
    const compiled = compileSql(bookQuery(txExecute))
    expect(compiled.text.replace(/\s+/g, ' ').trim()).toBe(
      'SELECT sku_id, COALESCE(SUM(quantity_on_hand), 0) AS quantity'
      + ' FROM inventory_stock_lots'
      + ' WHERE location_id = $1 AND sku_id IN ($2, $3)'
      + ' GROUP BY sku_id',
    )
    expect(compiled.params).toEqual(['LOC-MARKET-1', 'SKU-1', 'SKU-2'])
  })

  it('非盘点单不跑重复行守护：同 SKU 多批次仍可多行', async () => {
    // 守「别把盘点的约束误伤到全部单据」——出入库单同 SKU 不同批次天然要多行。
    // 用行为断言，不读源码字面量（原版整条只 grep 源码，标题主张没有任何行为覆盖）。
    const { fn: txExecute } = routingTxExecute([
      ['INSERT INTO inventory_stock_lots', [{ id: 7 }]],
      ['FOR UPDATE', [{ ...lotRow('99'), id: 7 }]],
      ['FROM inventory_skus', [SKU_SNAPSHOT_ROW]],
    ])
    const itemValues = vi.fn((_values: Record<string, unknown>) => ({
      returning: vi.fn().mockResolvedValue([{ id: 1 }]),
    }))
    const txInsert = vi.fn()
      .mockReturnValueOnce({ values: vi.fn().mockResolvedValue(undefined) })
      .mockReturnValue({ values: itemValues })
    mockDb.transaction.mockImplementation(async (callback: (tx: unknown) => unknown) => callback({
      execute: initializedCutoverExecutor(txExecute),
      insert: txInsert,
      update: vi.fn(() => ({ set: vi.fn(() => ({ where: vi.fn().mockResolvedValue(undefined) })) })),
    }))

    await createInventoryCoreDoc({
      docType: '市场产品盘溢',
      targetOrgNodeId: 'MARKET-1',
      items: [
        { skuId: 'SKU-1', quantity: 1, batchNo: 'B1' },
        { skuId: 'SKU-1', quantity: 2, batchNo: 'B2' },
      ],
    } as never)

    expect(itemValues).toHaveBeenCalledTimes(2)
  })

  it('盘点单类型集合与 movementPlan 的「不产流水」判定一致', () => {
    // 源码字面量守护：把盘点类型加进 INBOUND / OUTBOUND / RECEIVE_REQUIRED 会让它开始产流水，
    // 而本文件上面那条不变量用例只覆盖了当前这两种类型。
    // ⚠️ 刻意**不**断 NO_MOVEMENT_DOC_TYPES：movementPlan 对那个集合是 `return null`，
    //    放进去反而是更明确的「不产流水」，断它 not.toContain 是过严的假护栏。
    const engineSrc = readFileSync(resolve(process.cwd(), 'src/lib/inventory/engine.ts'), 'utf8')
    const stocktakeSrc = readFileSync(resolve(process.cwd(), 'src/lib/inventory/stocktake.ts'), 'utf8')
    const readSet = (src: string, file: string, name: string): string[] => {
      const block = src.match(
        new RegExp(`${name} = new Set<InventoryDocType>\\(\\[([\\s\\S]*?)\\]\\)`),
      )?.[1]
      expect(block, `${file} 里找不到 ${name}`).toBeTruthy()
      return [...block!.matchAll(/'([^']+)'/g)].map((m) => m[1])
    }
    const stocktake = readSet(stocktakeSrc, 'stocktake.ts', 'STOCKTAKE_DOC_TYPES')
    expect(stocktake).toEqual(['市场库存盘点', '分院库存盘点'])
    // 清单必须是 engine 与详情页共用的那一份，不能各写各的
    expect(engineSrc).toMatch(/import \{ STOCKTAKE_DOC_TYPES \} from '\.\/stocktake'/)
    expect(engineSrc).not.toMatch(/const STOCKTAKE_DOC_TYPES\s*=/)
    for (const name of ['RECEIVE_REQUIRED_DOC_TYPES', 'INBOUND_DOC_TYPES', 'OUTBOUND_DOC_TYPES']) {
      for (const t of stocktake) {
        expect(
          readSet(engineSrc, 'engine.ts', `const ${name}`),
          `${t} 不该出现在 ${name} 里，否则盘点会开始产库存流水`,
        ).not.toContain(t)
      }
    }
    // 每种盘点类型都必须在 assertLocationType 的 switch 里有对应分支，
    // 否则新增第三种盘点单会静默跳过主体类型校验
    for (const t of stocktake) {
      expect(engineSrc, `assertLocationType 缺少 ${t} 的分支`).toContain(`case '${t}':`)
    }
  })
})

/**
 * 办理台「单据」Tab 的过滤条件（#190）。
 *
 * Tab 里显示什么单完全由这几个 filter 决定：一个业务可能产出两种单（转换出库 + 入库），
 * 不产出新单的业务靠状态 / 撤回标记收窄。任一条件没落到 WHERE 上，
 * 用户看到的就是「别的业务的单」，而页面不会有任何异常表现。
 */
/*
 * 下面两个 describe（#190 过滤条件、#192 方向维）共用这套「抓 WHERE 再编译成 SQL」的夹具，
 * 所以放在 describe 外面。**不要**把它们复制一份到新 describe 里：
 * 两份夹具一旦漂移（比如只有一份用双 sink），漏掉 COUNT 条件那类缺陷就只在一半用例里可见。
 */
function capturingCountSelect(rows: unknown[], sink: { where?: unknown }) {
  return {
    from: () => ({
      where: async (cond: unknown) => {
        sink.where = cond
        return rows
      },
    }),
  }
}

function capturingDocsListSelect(rows: unknown[], sink: { where?: unknown }) {
  return {
    from: () => ({
      leftJoin: () => ({
        leftJoin: () => ({
          where: (cond: unknown) => {
            sink.where = cond
            return { orderBy: () => ({ limit: () => ({ offset: async () => rows }) }) }
          },
        }),
      }),
    }),
  }
}

/**
 * 断言一律落在**编译后的 SQL 文本 + 参数**上，不用遍历对象找字符串的那种匹配：
 * drizzle 的条件对象里挂着整张表的元数据，`sqlContains(where, '某列名')` 对
 * 任何条件都恒为真（列名来自表定义而非条件本身），假阳性会让「没加条件」的用例照样绿。
 */
function compile(where: unknown) {
  const compiled = new PgDialect().sqlToQuery(where as Parameters<PgDialect['sqlToQuery']>[0])
  return { text: compiled.sql, params: compiled.params.map((param) => String(param)) }
}

async function whereOf(filters: Parameters<typeof listInventoryCoreDocs>[0]) {
  // COUNT 与 LIST 用**各自的 sink**：共用一个的话后写的会覆盖前一个，
  // COUNT 漏掉过滤条件（total 把别的业务的单也算进去、分页器长出一堆空页）
  // 这类漂移就永远测不出来。拿到后逐条断言两份条件必须一致。
  const countSink: { where?: unknown } = {}
  const listSink: { where?: unknown } = {}
  mockDb.select
    .mockReturnValueOnce(capturingCountSelect([{ count: 0 }], countSink) as never)
    .mockReturnValueOnce(capturingDocsListSelect([], listSink) as never)
  await listInventoryCoreDocs(filters)
  const list = compile(listSink.where)
  const count = compile(countSink.where)
  expect(count.text, 'COUNT 与 LIST 的过滤条件必须一致').toBe(list.text)
  expect(count.params, 'COUNT 与 LIST 的绑定参数必须一致').toEqual(list.params)
  return list
}

describe('#190 单据列表的多类型 / 多状态 / 撤回标记过滤', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockDb.select.mockReset()
    mockDb.execute.mockReset()
    // admin 会话：聚焦类型/状态条件本身，不掺 scope 节点（scope 另有 §9.4 专项）。
    vi.mocked(isAdminScope).mockReturnValue(true)
    mockGetSession.mockResolvedValue(SESSION)
    mockDb.execute.mockResolvedValue([{ drifted: false }] as never)
  })

  it('docTypes 多值同时进条件：转换业务的出库单与入库单都在', async () => {
    const { text, params } = await whereOf({ docTypes: ['库存转换出库', '库存转换入库'] })
    expect(text).toContain('"doc_type" in')
    expect(params).toContain('库存转换出库')
    expect(params).toContain('库存转换入库')
  })

  it('docTypes 传空数组 fail-closed，不退化成「不过滤」', async () => {
    // 退化成不过滤的话，某个业务的 Tab 会把**全部单据**倒出来 —— 比少几行危险得多。
    const { text } = await whereOf({ docTypes: [] })
    expect(text).toContain('FALSE')
  })

  it('statuses 收窄：关闭采购只看已取消的采购订单', async () => {
    const { text, params } = await whereOf({ docTypes: ['采购订单'], statuses: ['已取消'] })
    // 断言列名而不只是参数值：'已取消' 误绑到别的文本列（remark、audit_remark…）
    // 时参数断言照样绿，而过滤完全没生效。
    expect(text).toContain('"status" in')
    expect(params).toContain('采购订单')
    expect(params).toContain('已取消')
  })

  it('statuses 传空数组同样 fail-closed', async () => {
    const { text } = await whereOf({ statuses: [] })
    expect(text).toContain('FALSE')
  })

  it('cancellationRequested 落到 cancellation_request_reason 非空', async () => {
    const { text } = await whereOf({ docTypes: ['品项公司发货'], cancellationRequested: true })
    expect(text).toContain('"cancellation_request_reason" is not null')
  })

  it('不传 cancellationRequested 时不加该条件', async () => {
    // 撤回业务之外的发货单查询不能被这个条件误伤：漏加会少看单，多加会把
    // 普通发货单全筛掉（它们的 reason 恒为空），两个方向都是静默错。
    const notPassed = await whereOf({ docTypes: ['品项公司发货'] })
    expect(notPassed.text).not.toContain('cancellation_request_reason')
  })

  it('cancellationRequested 的类型已收窄为 true —— 传 false 会放宽结果集，只能从类型上堵', async () => {
    // 运行时仍是 falsy 分支（退化成不过滤），这正是它危险的地方：写 `false` 的人
    // 想要的是「只看没申请过撤回的」，拿到的却是**全部**。所以类型写死 true，
    // 这里用 @ts-expect-error 越过类型检查，把「越过之后会发生什么」钉成文档。
    // @ts-expect-error 刻意传入类型禁止的 false，验证运行时的 fail-open 行为
    const explicitFalse = await whereOf({ docTypes: ['品项公司发货'], cancellationRequested: false })
    expect(explicitFalse.text).not.toContain('cancellation_request_reason')
  })

  /*
   * pendingItemScope（#192/#194/#335）。
   *
   * #335 起采购订单的所有行都经供应链采购入库，不再按 market_id 分流：
   * 条件只剩「存在未入库明细」。仍然最容易写坏、且都不会报错的地方：
   *   (a) 又按 market_id 分流 —— 市场行待入库的单会从供应链收货待办里消失；
   *   (b) EXISTS 忘了按 doc_id 关联外层 —— 只要**全库**存在一条未履约明细，条件恒真；
   *   (c) 未履约条件被简化掉 —— 已收满的行也算数，退化成「只要有明细就算待办」。
   */
  it("pendingItemScope='supply-chain' 生成不看 market_id 的未入库 EXISTS（#335）", async () => {
    const { text } = await whereOf({ docTypes: ['采购订单'], statuses: ['待收货'], pendingItemScope: 'supply-chain' })
    expect(text).toContain('EXISTS (')
    // 市场行同样经供应链采购入库，按 market_id 过滤会把它们挡在待办外
    expect(text).not.toContain('pending_item.market_id')
  })

  it('不传 pendingItemScope 时不加该 EXISTS —— 别误伤普通单据查询', async () => {
    // 多加会把「明细已全部入库」的单静默筛掉，误伤普通单据查询。
    const { text } = await whereOf({ docTypes: ['采购订单'], statuses: ['待收货'] })
    expect(text).not.toContain('pending_item')
    expect(text).not.toContain('EXISTS')
  })

  it('EXISTS 按 doc_id 关联外层单据，且只认未履约明细', async () => {
    /*
     * 这条是上面两条的承重梁：
     * 丢了 `pending_item.doc_id = inventory_docs.id`，EXISTS 就与外层无关 ——
     * 全库只要有一条未履约明细，**每一张**采购订单都会命中，过滤完全失效而 SQL 合法；
     * 丢了 `COALESCE(fulfilled_quantity,0) < quantity`，已入库满的行照样算数。
     * 两种退化都不会报错，只会让待办区悄悄变回原样。
     * `COALESCE` 不能简化成 `fulfilled_quantity < quantity`：该列可空，NULL 比较出 NULL，
     * 一条都没收过的明细反而不算「未履约」。
     */
    const { text } = await whereOf({ docTypes: ['采购订单'], pendingItemScope: 'supply-chain' })
    expect(text).toContain('FROM "inventory_doc_items" pending_item')
    expect(text).toContain('pending_item.doc_id = "inventory_docs"."id"')
    expect(text).toContain('COALESCE(pending_item.fulfilled_quantity, 0) < pending_item.quantity')
  })

  it('locationType 与 docTypes 叠加：转换单按层级隔离', async () => {
    // 市场办理台传 locationType=市场，条件里必须同时出现类型与层级两把锁。
    mockDb.select.mockReset()
    // locationType 分支会先查一次 inventory_locations 拿该类型的 org 节点。
    mockDb.select.mockReturnValueOnce({
      from: () => ({ where: async () => [{ orgNodeId: 'MKT-A' }] }),
    } as never)
    // 与 whereOf 同样用双 sink：共用一个的话，只有 COUNT 漏掉层级条件
    // （总数把别层级的转换单也算进去、翻出一堆空页）这种漂移测不出来。
    const countSink: { where?: unknown } = {}
    const listSink: { where?: unknown } = {}
    mockDb.select
      .mockReturnValueOnce(capturingCountSelect([{ count: 0 }], countSink) as never)
      .mockReturnValueOnce(capturingDocsListSelect([], listSink) as never)
    await listInventoryCoreDocs({ docTypes: ['库存转换出库', '库存转换入库'], locationType: '市场' })
    const compiled = new PgDialect().sqlToQuery(listSink.where as Parameters<PgDialect['sqlToQuery']>[0])
    const countCompiled = new PgDialect().sqlToQuery(countSink.where as Parameters<PgDialect['sqlToQuery']>[0])
    expect(countCompiled.sql, 'COUNT 与 LIST 的层级条件必须一致').toBe(compiled.sql)
    const params = compiled.params.map((param) => String(param))
    // 两种 docType 都要在：只剩出库的话，转换入库单会被静默漏掉，而 Tab 看起来完全正常。
    expect(params).toContain('库存转换出库')
    expect(params).toContain('库存转换入库')
    expect(params).toContain('MKT-A')
    // 层级过滤必须覆盖 source 与 target 两个端点（OR），只挡一端就挡不住跨层级的单。
    expect(compiled.sql).toContain('"source_org_node_id" in')
    expect(compiled.sql).toContain('"target_org_node_id" in')
    expect(compiled.sql).toMatch(/source_org_node_id" in[^)]*\)\s+or\s+"[^"]*"\."target_org_node_id" in/)
  })
})

/**
 * 待办区的方向维 `scopeRole`（#192 P1）。
 *
 * 单据可见性是**双端 OR**（`source OR target IN scoped`）—— 发货方和收货方都看得见
 * 自己经手的单，这对「本业务产出」是对的。但待办区问的是另一件事：这张单轮不轮得到我动手。
 * 服务端的写入动作一律拿**单边**校验：
 *   `confirmInventoryCoreReceive` → `assertOrgNodeVisible(session, head.target_org_node_id)`
 *   `receivePhysicalShipment` / `approveReturnForRestock` → `assertLocationWritable(session, target)`
 *   `approve|rejectItemCompanyShipmentCancellation` → `assertLocationWritable(session, source)`
 *
 * 没有这一维时，「门店调拨」的待办会把**发货门店**自己开出去的待收货调货单也列成
 * 「待我处理」并渲染「确认收货」按钮：点一次 PERMISSION_DENIED、刷新后那行还在，
 * 操作员无路可走，待办角标还跟着虚高。这个 describe 钉的就是这条收窄真的落到了 WHERE 上。
 */
describe('#192 待办区按 scopeRole 收窄到单个端点', () => {
  /** 单端收窄必须**挂在双端 OR 之外**（AND 上去），不能只出现在 OR 里面。 */
  const STANDALONE_TARGET = /\)\s+and\s+"[^"]*"\."target_org_node_id" in/
  const STANDALONE_SOURCE = /\)\s+and\s+"[^"]*"\."source_org_node_id" in/

  beforeEach(() => {
    vi.clearAllMocks()
    mockDb.select.mockReset()
    mockDb.execute.mockReset()
    mockGetSession.mockResolvedValue(SESSION)
    mockDb.execute.mockResolvedValue([{ drifted: false }] as never)
    // 非 admin：scopeRole 只有在会话真的受 scope 限制时才有意义。
    // SESSION 的角色是「总部 / HQ」，inventoryScopedOrgNodeIds 对总部不展开后代 → scoped = ['HQ']。
    vi.mocked(isAdminScope).mockReturnValue(false)
  })

  it("scopeRole='target' 在双端 OR 之外再 AND 一条 target 收窄", async () => {
    const { text, params } = await whereOf({
      docTypes: ['分院调货出库'],
      statuses: ['待收货'],
      scopeRole: 'target',
    })
    // 双端 OR 仍在（scope 本身不能被顶掉）……
    expect(text).toMatch(/source_org_node_id" in[^)]*\)\s+or\s+"[^"]*"\."target_org_node_id" in/)
    // ……并且额外 AND 了一条独立的 target 条件。
    expect(text).toMatch(STANDALONE_TARGET)
    expect(text).not.toMatch(STANDALONE_SOURCE)
    // 绑的是会话 scope 的节点，不是别处漂来的常量：双端 OR 用掉 2 个，单端收窄第 3 个。
    expect(params.filter((param) => param === 'HQ')).toHaveLength(3)
  })

  it("scopeRole='source' 收窄到发货端 —— 撤回审批唯一的方向", async () => {
    // 抄成 target 的话，供应链审批人（scope 只有总部 = 发货方）会一张待审批的单都看不到。
    const { text } = await whereOf({
      docTypes: ['品项公司发货'],
      statuses: ['待审批'],
      scopeRole: 'source',
      cancellationRequested: true,
    })
    expect(text).toMatch(STANDALONE_SOURCE)
    expect(text).not.toMatch(STANDALONE_TARGET)
  })

  it('不传 scopeRole 时可见性保持双端 OR —— produced 段不能被误伤', async () => {
    // 产出区必须让发货方看得见自己开的单；把 scopeRole 做成默认收窄会静默吞掉它们。
    const { text } = await whereOf({ docTypes: ['分院调货出库'] })
    expect(text).not.toMatch(STANDALONE_TARGET)
    expect(text).not.toMatch(STANDALONE_SOURCE)
    expect(text).toMatch(/source_org_node_id" in[^)]*\)\s+or\s+"[^"]*"\."target_org_node_id" in/)
  })

  it('admin（scoped === null）跳过 scopeRole，与现有 scope 分支同构', async () => {
    // admin 本就不受 scope 限制，拿一个空的「可见节点集合」去收窄会把待办区整个清空。
    vi.mocked(isAdminScope).mockReturnValue(true)
    const { text } = await whereOf({
      docTypes: ['分院调货出库'],
      statuses: ['待收货'],
      scopeRole: 'target',
    })
    expect(text).not.toContain('org_node_id')
    expect(text).not.toContain('FALSE')
  })

  it('scope 为空集时 fail-closed，不退化成「不收窄」', async () => {
    /*
     * 与 scope 分支同构：空集是「什么都看不见」，绝不是「不过滤」。
     *
     * 断言用**出现次数**而不是 `toContain('FALSE')`：空 scope 下基础 scope 分支自己
     * 就会压一个 FALSE 进去，只判存在性的话，把 scopeRole 的 fail-closed 整段删掉
     * 这条照样绿（验证过）。两个 FALSE 才说明两条分支各自都收了口。
     */
    mockGetSession.mockResolvedValue({
      ...(SESSION as unknown as Record<string, unknown>),
      roles: [],
      permissions: { actions: [], scopeStoreIds: [], scopeOrgNodeIds: [] },
    } as never)
    const { text } = await whereOf({
      docTypes: ['分院调货出库'],
      statuses: ['待收货'],
      scopeRole: 'target',
    })
    expect(text.match(/FALSE/g) ?? [], 'scope 分支与 scopeRole 分支各一个 FALSE').toHaveLength(2)
    expect(text).not.toMatch(STANDALONE_TARGET)
  })

  it('COUNT 与 LIST 都带上 scopeRole —— 待办角标不能比列表多', async () => {
    /*
     * whereOf 内部已逐条断言两份条件一致，这里把「为什么一致很重要」写下来并再点一次名：
     * 只有 LIST 收窄、COUNT 不收窄的话，角标数字会把对端的单也算进去 ——
     * 用户看到「待我处理 6」却只列出 2 行，而且怎么点都消不掉那 4。
     */
    const { text } = await whereOf({
      docTypes: ['分院配货'],
      statuses: ['待收货'],
      scopeRole: 'target',
    })
    expect(text).toMatch(STANDALONE_TARGET)
  })
})

/**
 * 通用建单的层级 action 校验（#191；甲方 2026-09-21 拍板改成「显式放开向下代建」）。
 *
 * 入口的 `withAnyPermission` 是「三个 operate 任一」、不按 docType 分层，只靠它，一个仅有
 * `inventory:store_operate` 的账号也能建「市场产品报损」这类上级单据。这道闸的职责是
 * **只堵向上、显式放开「scope 能向下展开」的那一档代建**：
 *   - 向上越级（门店建市场/供应链单、市场建供应链单）→ PERMISSION_DENIED；
 *   - 市场替门店代建 → 放行，这是生产既有工作流，由 inventoryDelegatableOperateActions
 *     的层级序显式表达，而不是靠权限并集碰巧漏出来；
 *   - 总部替市场/门店代建 → **也拒**。access.ts 的 inventoryScopedOrgNodeIds 对总部绑定
 *     不展开后代，总部账号选不出下级主体，放行只是把同一个 403 推迟到 assertOrgNodeVisible
 *     （错误更晚、更含糊），顺带在 UI 下拉里堆 9 个死路选项。见 LEVEL_SCOPE_EXPANDS_DOWNWARD。
 * 代建的**范围**由 assertOrgNodeVisible + assertGenericDocLocationRules 另行封死。
 */
describe('#191 通用建单按 docType 校验层级 operate 权限', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockDb.select.mockReset()
    mockDb.execute.mockReset()
    mockGetSession.mockResolvedValue(SESSION)
    vi.mocked(isAdminScope).mockReturnValue(false)
    mockDb.execute.mockResolvedValue([{ drifted: false }] as never)
  })

  function sessionWith(actions: string[]) {
    vi.mocked(hasPermission).mockImplementation((_session, action) => actions.includes(action))
  }

  function createDoc(docType: string) {
    return createInventoryCoreDoc({
      docType: docType as never,
      sourceOrgNodeId: 'NODE-A1',
      targetOrgNodeId: null,
      docDate: '2026-09-19',
      remark: '',
      items: [{ skuId: 'SKU-1', quantity: 1 } as never],
    })
  }

  /** 向上越级：只持有下级 operate，去建上级层级的单据 —— 必须被这道闸拦下。 */
  const UPWARD_CASES: Array<[string, string]> = [
    ['市场产品报损', 'inventory:store_operate'],
    ['市场库存盘点', 'inventory:store_operate'],
    ['内部领用', 'inventory:market_operate'],
    ['内部领用', 'inventory:store_operate'],
  ]

  it.each(UPWARD_CASES)('向上越级仍拒：%s 不接受 %s', async (docType, heldAction) => {
    sessionWith([heldAction])
    /*
     * 必须连文案一起断言。光断言 'PERMISSION_DENIED' 是测不动的：这些用例的目标节点
     * 本来也不在会话 scope 里，后面的 assertOrgNodeVisible 同样抛 PERMISSION_DENIED，
     * 于是「把候选集改成恒返回三个 action」这种变异照样全绿。
     * 文案里的「库存操作权限」只有层级 action 闸会写。
     */
    await expect(createDoc(docType)).rejects.toThrow('PERMISSION_DENIED')
    await expect(createDoc(docType)).rejects.toThrow('库存操作权限')
  })

  /**
   * 总部「代建」下级单据：也拒。
   *
   * 不是向上越级，而是**代建无意义**：inventoryScopedOrgNodeIds 对 scopeType==='总部'
   * 的绑定只计入自身 scopeId、不展开后代，所以总部账号选不出市场/门店主体。放行的话
   * 同一个请求照样死在后面的 assertOrgNodeVisible，只是错误更晚、文案是「无权操作该出库主体」
   * 而不是「缺少市场库存操作权限」，用户只会以为是主体选错了。干脆在层级闸就拒。
   */
  const SUPPLY_CHAIN_DELEGATION_CASES: Array<[string, string]> = [
    ['市场产品报损', 'inventory:supply_chain_operate'],
    ['市场库存盘点', 'inventory:supply_chain_operate'],
    ['院产品报损', 'inventory:supply_chain_operate'],
    ['分院库存盘点', 'inventory:supply_chain_operate'],
  ]

  it.each(SUPPLY_CHAIN_DELEGATION_CASES)(
    '总部代建仍拒（scope 不展开后代）：%s 不接受 %s',
    async (docType, heldAction) => {
      sessionWith([heldAction])
      // 同 UPWARD_CASES：必须连文案一起断，否则「候选集恒返回三个 action」的变异会假绿
      // （目标节点本来也不在 scope 里，assertOrgNodeVisible 同样抛 PERMISSION_DENIED）。
      await expect(createDoc(docType)).rejects.toThrow('PERMISSION_DENIED')
      await expect(createDoc(docType)).rejects.toThrow('库存操作权限')
    },
  )

  /** 向下代建：持有市场 operate 去建门店单据 —— 显式放行（甲方 2026-09-21）。 */
  const DOWNWARD_CASES: Array<[string, string]> = [
    ['院产品报损', 'inventory:market_operate'],
    ['分院库存盘点', 'inventory:market_operate'],
  ]

  it.each(DOWNWARD_CASES)('向下代建放行：%s 可由持有 %s 的账号建', async (docType, heldAction) => {
    // 与下面那条同一写法：只断言「没被层级 action 闸拦住」，
    // 后面的主体可见性/批次校验不在本用例范围，接受任何其它失败。
    sessionWith([heldAction])
    let error: unknown
    try {
      await createDoc(docType)
    } catch (err) {
      error = err
    }
    expect(String((error as Error)?.message ?? ''), docType).not.toContain('库存操作权限')
  })

  it('持有对应层级权限时不会被这道闸拦下', async () => {
    // 只断言「没被权限闸拦住」：后面的主体/批次校验不在本用例范围，
    // 所以接受任何非 PERMISSION_DENIED 的失败。
    sessionWith(['inventory:store_operate'])
    let error: unknown
    try {
      await createInventoryCoreDoc({
        docType: '院产品报损' as never,
        sourceOrgNodeId: 'NODE-A1',
        targetOrgNodeId: null,
        docDate: '2026-09-19',
        remark: '',
        items: [{ skuId: 'SKU-1', quantity: 1 } as never],
      })
    } catch (err) {
      error = err
    }
    expect(String((error as Error)?.message ?? '')).not.toContain('库存操作权限')
  })

  it('总部建自己层级的内部领用仍放行 —— 收紧代建不能把本层级一起收掉', async () => {
    /*
     * 候选集的构造是「本层级 ∪ scope 能向下展开的上级」。谁要是把「本层级永远入选」
     * 那一半删掉（只留 LEVEL_SCOPE_EXPANDS_DOWNWARD 过滤），供应链单的候选集会塌成空，
     * 内部领用变成任何人都建不了，而上面所有「拒」的用例照样全绿。
     */
    sessionWith(['inventory:supply_chain_operate'])
    let error: unknown
    try {
      await createDoc('内部领用')
    } catch (err) {
      error = err
    }
    expect(String((error as Error)?.message ?? '')).not.toContain('库存操作权限')
  })
})

/**
 * 多绑定会话不能跨角色拼接「action 来自这条绑定、scope 来自那条绑定」（#191 round-2）。
 *
 * 入口的 withAnyPermission 收的是「持有三个 operate 任一」的角色并集，
 * 所以光加一道 `hasPermission(session, 候选 action)` 是半拉子：action 用并集、
 * scope 也用并集，两者可以来自完全不同的绑定。
 *
 * ⚠️ 放开向下代建（2026-09-21）之后这个守护**没有失效**，只是发生位置变了：
 * 门店单的候选集含 market_operate，市场绑定替下属门店建单**本来就合法**（下面第一条）；
 * 真正还会拼接的是「候选集里一个都不持有的绑定提供了 scope」——
 * 对应下面两条反例：一条被 action 闸拒（会话里根本没有候选 action），
 * 一条被 scopeSessionToActions 收窄后的 scope 拒（候选 action 与目标节点来自不同绑定）。
 */
describe('#191 层级权限必须与 scope 落在同一条角色绑定上', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockDb.select.mockReset()
    mockDb.execute.mockReset()
    vi.mocked(isAdminScope).mockReturnValue(false)
    // 真实语义：hasPermission 看的是会话 actions 并集
    vi.mocked(hasPermission).mockImplementation(
      (session, action) => (session.permissions.actions ?? []).includes(action),
    )
    mockDb.execute.mockResolvedValue([{ drifted: false }] as never)
  })

  /** 市场 A 绑 market_operate（可见 A 及其下属门店 A1）+ 门店 B 绑 store_operate（只可见 B）。 */
  function multiBindingSession() {
    return {
      employeeId: 'E-MULTI',
      name: '多绑定用户',
      phone: '13800000000',
      roles: [
        {
          role: 'inventory_market_operator', scopeId: 'MKT-A', scopeType: '市场',
          actions: ['inventory:list', 'inventory:market_operate'],
          scopeStoreIds: ['STORE-A1'],
          scopeOrgNodeIds: ['MKT-A', 'NODE-A1'],
        },
        {
          role: 'inventory_store_operator', scopeId: 'NODE-B', scopeType: '门店',
          actions: ['inventory:list', 'inventory:store_operate'],
          scopeStoreIds: ['STORE-B'],
          scopeOrgNodeIds: ['NODE-B'],
        },
      ],
      permissions: {
        actions: ['inventory:list', 'inventory:market_operate', 'inventory:store_operate'],
        scopeStoreIds: ['STORE-A1', 'STORE-B'],
        scopeOrgNodeIds: ['MKT-A', 'NODE-A1', 'NODE-B'],
      },
    } as never
  }

  it('市场绑定可替其下属门店建门店单（向下代建）', async () => {
    mockGetSession.mockResolvedValue(multiBindingSession())
    /*
     * 门店 A1 只在市场 A 那条绑定的范围里。改口径前这被判作「拼接」而拒绝；
     * 甲方 2026-09-21 拍板后它是合法的向下代建：市场 A 的绑定既持有候选 action
     * （门店单候选集 = [market_operate, store_operate]）、其 scope 又覆盖 A1，
     * 两者落在**同一条**绑定上 —— 市场 scope 确实展开到下属门店，代建能走通。
     */
    let error: unknown
    try {
      await createInventoryCoreDoc({
        docType: '院产品报损' as never,
        sourceOrgNodeId: 'NODE-A1',
        targetOrgNodeId: null,
        docDate: '2026-09-19',
        remark: '',
        items: [{ skuId: 'SKU-1', quantity: 1 } as never],
      })
    } catch (err) {
      error = err
    }
    // 只断言没被权限/可见性闸拦下；后续主体类型、批次等校验不在本用例范围
    expect(String((error as Error)?.message ?? '')).not.toMatch(/PERMISSION_DENIED|无权|库存操作权限/)
  })

  it('同一条绑定内的门店（门店 B）不被误伤', async () => {
    mockGetSession.mockResolvedValue(multiBindingSession())
    let error: unknown
    try {
      await createInventoryCoreDoc({
        docType: '院产品报损' as never,
        sourceOrgNodeId: 'NODE-B',
        targetOrgNodeId: null,
        docDate: '2026-09-19',
        remark: '',
        items: [{ skuId: 'SKU-1', quantity: 1 } as never],
      })
    } catch (err) {
      error = err
    }
    // 只断言没被可见性/权限闸拦下；后续主体类型、批次等校验不在本用例范围
    expect(String((error as Error)?.message ?? '')).not.toMatch(/PERMISSION_DENIED|无权|库存操作权限/)
  })

  /**
   * 拼接反例其一：scope 来自一条**根本不持有任何候选 operate** 的绑定。
   *
   * 角色 1 = store_operate @ 门店 B（让入口的 withAnyPermission 放行）；
   * 角色 2 = market_price_view @ 市场 A（只提供可见性，不含任何 operate）。
   * 对市场 A 建市场单：候选集 = [market_operate]，两条绑定都不持有
   * —— 这正是新语义下层级 action 闸的全部价值：向下代建放开了，但「用门店权限 + 市场可见性
   * 拼出一张市场单」仍然拒。
   */
  function splicingSession() {
    return {
      employeeId: 'E-SPLICE',
      name: '拼接用户',
      phone: '13800000000',
      roles: [
        {
          role: 'inventory_store_operator', scopeId: 'NODE-B', scopeType: '门店',
          actions: ['inventory:list', 'inventory:store_operate'],
          scopeStoreIds: ['STORE-B'],
          scopeOrgNodeIds: ['NODE-B'],
        },
        {
          role: 'inventory_market_finance', scopeId: 'MKT-A', scopeType: '市场',
          actions: ['inventory:list', 'inventory:market_price_view'],
          scopeStoreIds: ['STORE-A1'],
          scopeOrgNodeIds: ['MKT-A', 'NODE-A1'],
        },
      ],
      permissions: {
        actions: ['inventory:list', 'inventory:store_operate', 'inventory:market_price_view'],
        scopeStoreIds: ['STORE-A1', 'STORE-B'],
        scopeOrgNodeIds: ['MKT-A', 'NODE-A1', 'NODE-B'],
      },
    } as never
  }

  it('门店 operate + 市场只读可见性拼不出一张市场单', async () => {
    mockGetSession.mockResolvedValue(splicingSession())
    // 文案不再提「或其上级层级」：市场单的候选集里只剩市场自己（总部 scope 不展开）。
    await expect(
      createInventoryCoreDoc({
        docType: '市场产品报损' as never,
        sourceOrgNodeId: 'MKT-A',
        targetOrgNodeId: null,
        docDate: '2026-09-19',
        remark: '',
        items: [{ skuId: 'SKU-1', quantity: 1 } as never],
      }),
    ).rejects.toThrow('PERMISSION_DENIED: 缺少市场库存操作权限')
  })

  it('市场单的可见性只认持有候选 operate 的那条绑定，不吃门店绑定的范围', async () => {
    /*
     * 拼接反例其二，专门钉住 scopeSessionToActions(session, allowedActions)：
     * 市场单候选集 = [market_operate] → 只有市场 A 那条绑定入选 →
     * scope 收窄成 [MKT-A, NODE-A1]，门店 B 不在其中。
     * 把 engine 里的 actingSession 退回外层 session（action 并集 + scope 并集），
     * NODE-B 会混进可见范围，这条立刻转红。
     *
     * 断言精确到 assertOrgNodeVisible 的那句文案：写成宽松的 /PERMISSION_DENIED/ 的话，
     * 上一条层级闸（'缺少市场库存操作权限'）也能让它绿，就区分不出「scope 有没有跟着收窄」。
     */
    mockGetSession.mockResolvedValue(multiBindingSession())
    await expect(
      createInventoryCoreDoc({
        docType: '市场产品报损' as never,
        sourceOrgNodeId: 'NODE-B',
        targetOrgNodeId: null,
        docDate: '2026-09-19',
        remark: '',
        items: [{ skuId: 'SKU-1', quantity: 1 } as never],
      }),
    ).rejects.toThrow('PERMISSION_DENIED: 无权操作该组织节点单据')
  })
})

/**
 * admin 不能被层级权限收紧误伤（#191 round-3，两个谱系都点名缺这条）。
 *
 * `scopeSessionToActions` 按 action 过滤角色，万一哪天 admin 角色的 actions 不再是
 * 字面量枚举（比如改成通配或延迟解析），过滤会把 admin 角色整个滤掉 →
 * `isAdminScope` 转假 → 全局范围塌成空集 → admin 反而建不了单。
 * 这条用**带完整角色级元数据的真实形态 admin 会话**把它钉住。
 */
describe('#191 层级权限收紧不误伤 admin', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockDb.select.mockReset()
    mockDb.execute.mockReset()
    vi.mocked(hasPermission).mockImplementation(
      (session, action) => (session.permissions.actions ?? []).includes(action),
    )
    mockDb.execute.mockResolvedValue([{ drifted: false }] as never)
  })

  it('admin 建任意层级的通用单都不被权限或可见性闸拦下', async () => {
    // admin 的 scope 是「全局不受限」，靠 isAdminScope 判定；这里连同角色级元数据
    // 一起给全，走的是真实的收窄路径而不是无元数据的兼容 no-op。
    vi.mocked(isAdminScope).mockReturnValue(true)
    mockGetSession.mockResolvedValue({
      employeeId: 'E-ADMIN',
      name: '超管',
      phone: '13800000000',
      roles: [{
        role: 'admin', scopeId: 'HQ', scopeType: '总部',
        actions: [
          'inventory:list',
          'inventory:supply_chain_operate',
          'inventory:market_operate',
          'inventory:store_operate',
        ],
        scopeStoreIds: [],
        scopeOrgNodeIds: ['HQ'],
      }],
      permissions: {
        actions: [
          'inventory:list',
          'inventory:supply_chain_operate',
          'inventory:market_operate',
          'inventory:store_operate',
        ],
        scopeStoreIds: [],
        scopeOrgNodeIds: ['HQ'],
      },
    } as never)

    for (const docType of ['院产品报损', '市场产品报损', '内部领用']) {
      let error: unknown
      try {
        await createInventoryCoreDoc({
          docType: docType as never,
          sourceOrgNodeId: 'NODE-ANY',
          targetOrgNodeId: null,
          docDate: '2026-09-19',
          remark: '',
          items: [{ skuId: 'SKU-1', quantity: 1 } as never],
        })
      } catch (err) {
        error = err
      }
      expect(String((error as Error)?.message ?? ''), docType).not.toMatch(
        /PERMISSION_DENIED|无权|库存操作权限/,
      )
    }
  })
})

/**
 * #200 的补充回归：鉴权端口径的**前提不变量** + 代建 / 调货两条正向主干。
 *
 * 主实现与它的主回归在本文件上方的 `#200 建单 scope 按真正被改动的主体校验`：
 * 鉴权端由 `movementPlan` 动态推导（`locationRole === 'target'` 取 target，否则
 * `source ?? target`），不维护逐类型的端点表。这里补的是那套实现**没有**覆盖、
 * 但它的安全性恰恰**依赖**的几条：
 *
 *  - 【S1】`plan === null` 时回落 `source ?? target` 这条豁免，只有在该类型是
 *    同主体单据（两端已被归一）时才安全 —— 新增一个既无静态流水方向、又不在
 *    INTERNAL_SAME_NODE 里的通用类型，鉴权端就会重新变成「谁先给谁算」。
 *  - 【N6】同主体单据的形状校验必须先于 scope：无权端落在 source 时报的仍是形状错，
 *    否则 PERMISSION_DENIED 会反过来变成探测无权节点的信道。
 *  - 【P1/P2/P3】上级替 scope 内下级代建、调货对端不做建单期 scope 校验、
 *    同主体单据只传一端 —— 这三条主干不能被这次收窄误伤。
 *
 * ⚠️ 这个 describe 自带 beforeEach 把 isAdminScope 关掉：文件顶部的模块 mock 默认
 * `() => true`，`vi.clearAllMocks()` 只清调用记录不恢复实现。忘了关的话
 * `inventoryScopedOrgNodeIds` 直接返回 null，下面所有负向用例全部假绿。
 */
describe('#200 建单鉴权端的前提不变量与代建 / 调货正向回归', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockDb.select.mockReset()
    mockDb.execute.mockReset()
    mockDb.transaction.mockReset()
    vi.mocked(isAdminScope).mockReturnValue(false)
    vi.mocked(hasPermission).mockImplementation(
      (session, action) => (session!.permissions.actions ?? []).includes(action),
    )
    mockDb.execute.mockResolvedValue([] as never)
  })

  /**
   * 「价格档位」describe 里的 sessionWithActions 是那个 describe 内部的局部函数，
   * 这里取不到，只能自建。形状必须带 roles[].actions / scopeStoreIds / scopeOrgNodeIds：
   * withAnyPermission 先走 scopeSessionToActions 按 action 过滤角色，角色上缺这三个数组
   * 会被判定为「无 scope 元数据」而整条收窄被跳过（见 lib/action-scope.ts:17-22）。
   */
  function scopedSession(
    actions: string[],
    scopeOrgNodeIds: string[],
    scopeType: '市场' | '门店',
  ) {
    return {
      employeeId: 'E-200',
      name: '#200 测试用户',
      phone: '13800000000',
      roles: [{
        role: 'inventory_op',
        scopeId: scopeOrgNodeIds[0],
        scopeType,
        actions,
        scopeStoreIds: [],
        scopeOrgNodeIds,
      }],
      permissions: { actions, scopeStoreIds: [], scopeOrgNodeIds },
    }
  }

  /** 门店会话：scope 只有 ORG-S1，ORG-S2 在 scope 外 */
  function storeS1Session() {
    return scopedSession(['inventory:list', 'inventory:store_operate'], ['ORG-S1'], '门店')
  }

  function createAndCatch(input: Record<string, unknown>): Promise<Error> {
    return createInventoryCoreDoc(input as never).then(
      () => { throw new Error('NO-ERROR：建单本应被拒绝，却成功返回') },
      (err: Error) => err,
    )
  }

  /** 前置校验不该碰库：证明拒绝发生在 ensureOrgNodeLocation / 事务之前 */
  function expectNoDbTouched() {
    expect(mockDb.transaction, 'db.transaction 不该被调用').not.toHaveBeenCalled()
    expect(mockDb.execute, 'db.execute 不该被调用').not.toHaveBeenCalled()
    expect(mockDb.select, 'db.select 不该被调用').not.toHaveBeenCalled()
  }

  // ── 负向 ────────────────────────────────────────────────────────────────

  /*
   * 上方 describe 的「同主体单据：source 与 target 都给且不一致时拒绝」只覆盖了
   * **无权端在 target** 的方向（source 有权、target 无权）。这里补对称的一侧：
   * 无权端落在 source 时，报的必须仍是形状错。
   *
   * 这条钉的是顺序不变量 —— INTERNAL_SAME_NODE 的归一校验必须早于 assertOrgNodeVisible。
   * 把它挪到 scope 之后，本用例会变成 PERMISSION_DENIED：那就等于告诉越权方
   * 「ORG-S2 这个节点你没权」，和 #200 刚堵掉的那条探测信道同源。
   */
  it('【N6】同主体单据方向对称：无权端在 source 时报的仍是形状错，不是 PERMISSION_DENIED', async () => {
    mockGetSession.mockResolvedValue(storeS1Session() as never)

    const err = await createAndCatch({
      docType: '院产品报损',
      sourceOrgNodeId: 'ORG-S2',   // scope 外
      targetOrgNodeId: 'ORG-S1',   // scope 内
      items: [{ skuId: 'SKU-1', quantity: 1 }],
    })

    expect(err.message).toContain('出库主体与入库主体必须是同一个')
    expect(err.message).not.toContain('PERMISSION_DENIED')
    expectNoDbTouched()
  })

  // ── 正向 ────────────────────────────────────────────────────────────────

  it('【P1】市场会话替 scope 内门店建院顾客退货 → 前置校验全过，走进事务', async () => {
    mockGetSession.mockResolvedValue(scopedSession(
      ['inventory:list', 'inventory:store_operate'],
      ['ORG-M1', 'ORG-S1'],
      '市场',
    ) as never)
    mockDb.select.mockImplementation(() => selectWithLimit([{
      locationId: 'STORE-1', orgNodeId: 'ORG-S1', locationType: '门店',
      parentLocationId: 'ORG-M1', isActive: true,
    }]))
    mockDb.transaction.mockImplementationOnce(async (callback: (tx: unknown) => unknown) => callback({
      execute: vi.fn().mockRejectedValue(new Error('STOP-AFTER-VALIDATION')),
    } as never))

    const err = await createAndCatch({
      docType: '院顾客退货',
      targetOrgNodeId: 'ORG-S1',
      items: [{ skuId: 'SKU-1', quantity: 1 }],
    })

    // 修完不能把「上级替 scope 内门店代建」一并挡死。
    expect(err.message).toBe('STOP-AFTER-VALIDATION')
  })

  it('【P2】调货单的对端仍不做建单期 scope 校验：门店 → scope 外门店必须放行', async () => {
    /*
     * 这是 tests/e2e-actions/smoke-inventory-transfer.impl.mjs 三条 L2 冒烟的廉价镜像：
     * storeA1 建「分院调货出库」STA1→STA2 期望成功。target 的校验被有意推迟到
     * confirmInventoryCoreReceive（收货方自己的 scope 把关），建单期加 guard 会把
     * 「门店发起调货」这条主干直接打死，而单测若没有这一条则全绿、只有冒烟才红。
     */
    mockGetSession.mockResolvedValue(storeS1Session() as never)
    mockDb.select
      .mockReturnValueOnce(selectWithLimit([{
        locationId: 'STORE-1', orgNodeId: 'ORG-S1', locationType: '门店',
        parentLocationId: 'MARKET-1', isActive: true,
      }]))
      .mockReturnValueOnce(selectWithLimit([{
        locationId: 'STORE-2', orgNodeId: 'ORG-S2', locationType: '门店',
        parentLocationId: 'MARKET-1', isActive: true,
      }]))
      .mockReturnValueOnce(selectWithoutLimit([
        { locationId: 'STORE-1', orgNodeId: 'ORG-S1', locationType: '门店', parentLocationId: 'MARKET-1' },
        { locationId: 'STORE-2', orgNodeId: 'ORG-S2', locationType: '门店', parentLocationId: 'MARKET-1' },
      ]))
    mockDb.transaction.mockImplementationOnce(async (callback: (tx: unknown) => unknown) => callback({
      execute: vi.fn().mockRejectedValue(new Error('STOP-AFTER-VALIDATION')),
    } as never))

    const err = await createAndCatch({
      docType: '分院调货出库',
      sourceOrgNodeId: 'ORG-S1',
      targetOrgNodeId: 'ORG-S2',
      items: [{ skuId: 'SKU-1', quantity: 1, lotId: 1 }],
    })

    expect(err.message).toBe('STOP-AFTER-VALIDATION')
  })

  it('【P3】同主体单据只传一端仍可建（市场产品盘溢只给 target）', async () => {
    mockGetSession.mockResolvedValue(scopedSession(
      ['inventory:list', 'inventory:market_operate'],
      ['MARKET-B'],
      '市场',
    ) as never)
    mockDb.select.mockImplementation(() => selectWithLimit([{
      locationId: 'MARKET-B', orgNodeId: 'MARKET-B', locationType: '市场',
      parentLocationId: 'HQ', isActive: true,
    }]))
    mockDb.transaction.mockImplementationOnce(async (callback: (tx: unknown) => unknown) => callback({
      execute: vi.fn().mockRejectedValue(new Error('STOP-AFTER-VALIDATION')),
    } as never))

    const err = await createAndCatch({
      docType: '市场产品盘溢',
      targetOrgNodeId: 'MARKET-B',
      items: [{ skuId: 'SKU-1', quantity: 1 }],
    })

    expect(err.message).toBe('STOP-AFTER-VALIDATION')
  })

  // ── 前提不变量 ──────────────────────────────────────────────────────────

  /*
   * 建单鉴权端的推导是：
   *   plan = movementPlan(docType, defaultStatusForDoc(docType))
   *   actingOrgNodeId = plan?.locationRole === 'target' ? target : (source ?? target)
   *
   * `plan === null` 那一支回落 `source ?? target`，**只有当两端已被归一成同一个 id 时
   * 才没有歧义**。当前的 10 种通用类型里，plan 为 null 的两种（市场产品报损 / 院产品报损，
   * 建单即「待审批」）恰好都在 INTERNAL_SAME_NODE_DOC_TYPES 里，所以是安全的 ——
   * 但这是一个**巧合级**的前提，代码里没有任何地方强制它。
   *
   * 新增一个既无静态流水方向、又不在 INTERNAL_SAME_NODE 里的通用类型（或者把现有
   * 报损类从 INTERNAL_SAME_NODE 里摘掉），鉴权端立刻退化成「调用方先给哪个就认哪个」：
   * 传一个自己有权的 source 当挡箭牌 + 一个无权的 target，就是 #200 原始的攻击载荷。
   * 那种改动不会让上面任何一条行为用例变红，只有这条会。
   *
   * 用源码字面量读集合（与本文件「盘点单类型集合与 movementPlan 的『不产流水』判定一致」
   * 同套路）：这些集合都不是导出符号。
   */
  it('【S1】plan 为 null 的通用单据必须是同主体单据 —— 否则鉴权端会退回 source ?? target', () => {
    const source = readFileSync(resolve(__dirname, 'engine.ts'), 'utf8')
    const readSet = (name: string): Set<string> => {
      const block = source.match(
        new RegExp(`const ${name} = new Set<InventoryDocType>\\(\\[([\\s\\S]*?)\\]\\)`),
      )?.[1]
      expect(block, `engine.ts 里找不到 ${name}`).toBeTruthy()
      return new Set([...block!.matchAll(/'([^']+)'/g)].map((m) => m[1]))
    }
    const noMovement = readSet('NO_MOVEMENT_DOC_TYPES')
    const approval = readSet('APPROVAL_DOC_TYPES')
    const receive = readSet('RECEIVE_REQUIRED_DOC_TYPES')
    const inbound = readSet('INBOUND_DOC_TYPES')
    const outbound = readSet('OUTBOUND_DOC_TYPES')
    const sameNode = readSet('INTERNAL_SAME_NODE_DOC_TYPES')

    // 断言「至少命中一个 plan 为 null 的类型」，否则改坏 readSet（比如集合改名后
    // block 取空、每个 has() 恒 false）会让整条守护变成空转还照样全绿。
    const planIsNull = (docType: string) =>
      // defaultStatusForDoc：待审批类型建单时 status='待审批' → movementPlan 直接 return null
      approval.has(docType)
      || noMovement.has(docType)
      || !(receive.has(docType) || inbound.has(docType) || outbound.has(docType))

    const nullPlanTypes = INVENTORY_GENERIC_DOC_TYPES.filter(planIsNull)
    expect(nullPlanTypes.length, '一个 plan 为 null 的通用类型都没匹配到，八成是集合读空了').toBeGreaterThan(0)

    for (const docType of nullPlanTypes) {
      expect(
        sameNode.has(docType),
        `${docType} 建单时 movementPlan 为 null，鉴权端会回落 source ?? target；`
        + '它必须同时在 INTERNAL_SAME_NODE_DOC_TYPES 里（两端先被归一），否则调用方可以拿'
        + '一个自己有权的无关主体过鉴权、把库存改动落到无权的那一端',
      ).toBe(true)
    }
  })
})

describe('SKU 候选检索过滤（#339）', () => {
  const dialect = new PgDialect()
  function render(filters: Parameters<typeof inventorySkuOptionConditions>[0]) {
    const conditions = inventorySkuOptionConditions(filters)
    return conditions.map((condition) => dialect.sqlToQuery(condition))
  }

  it('门店报货：reportable + 可用于门店所属市场（供应链放行，非供应链须归属该市场）', () => {
    const [reportable, market] = render({ reportable: true, availableToMarketId: 'M1' })
    expect(reportable.sql).toBe('"inventory_skus"."is_reportable" = $1')
    expect(reportable.params).toEqual([true])
    expect(market.sql).toBe('("inventory_skus"."source_type" = $1 or "inventory_skus"."owner_market_id" = $2)')
    expect(market.params).toEqual(['供应链', 'M1'])
  })

  it('品项公司报货需求：只出供应链来源 + reportable', () => {
    const rendered = render({ sourceType: '供应链', reportable: true })
    expect(rendered.map((q) => q.sql)).toEqual([
      '"inventory_skus"."source_type" = $1',
      '"inventory_skus"."is_reportable" = $1',
    ])
    expect(rendered.map((q) => q.params)).toEqual([['供应链'], [true]])
  })

  it('自采入库：只出归属本市场的非供应链商品（AND，不是 OR）', () => {
    const [owned] = render({ ownedByMarketId: 'M1' })
    expect(owned.sql).toBe('("inventory_skus"."source_type" <> $1 and "inventory_skus"."owner_market_id" = $2)')
    expect(owned.params).toEqual(['供应链', 'M1'])
  })

  it('关键词按编号/名称/规格/系列匹配，转义 LIKE 通配符与反斜杠，空白关键词不加条件', () => {
    const [keyword] = render({ keyword: ' 5%_\\x ' })
    expect(keyword.sql).toContain('"inventory_skus"."product_code" ilike')
    expect(keyword.sql).toContain('"inventory_skus"."product_name" ilike')
    expect(keyword.sql).toContain('"inventory_skus"."spec_name" ilike')
    expect(keyword.params[0]).toBe('%5\\%\\_\\\\x%')
    expect(render({ keyword: '   ' })).toEqual([])
  })

  it('非法参数拒绝：未知来源 / 非字符串市场 id', () => {
    expect(() => render({ sourceType: '其他' as never })).toThrow(/无效库存商品来源/)
    expect(() => render({ availableToMarketId: 123 as never })).toThrow(/可用市场无效/)
    expect(() => render({ ownedByMarketId: '  ' })).toThrow(/归属市场无效/)
  })

  it('skuIds 为空数组时不查库直接返回空；超过 100 个拒绝', async () => {
    mockGetSession.mockResolvedValue(SESSION)
    mockDb.select.mockClear()
    mockDb.execute.mockClear()
    await expect(listInventorySkus({ skuIds: [] })).resolves.toEqual({ data: [], total: 0 })
    expect(mockDb.select).not.toHaveBeenCalled()
    expect(mockDb.execute).not.toHaveBeenCalled()
    const tooMany = Array.from({ length: 101 }, (_, index) => `SKU-${index}`)
    await expect(listInventorySkus({ skuIds: tooMany })).rejects.toThrow(/最多 100 个/)
  })
})
