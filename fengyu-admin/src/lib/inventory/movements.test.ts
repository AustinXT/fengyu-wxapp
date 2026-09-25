import { beforeEach, describe, expect, it, vi } from 'vitest'
import { PgDialect } from 'drizzle-orm/pg-core'
import type { SQL } from 'drizzle-orm'

const { mockDb, mockGetSession } = vi.hoisted(() => ({
  mockDb: { execute: vi.fn() },
  mockGetSession: vi.fn(),
}))

vi.mock('@/db', () => ({ db: mockDb }))
vi.mock('@/lib/auth', () => ({ getSession: mockGetSession }))

import { iterateExportPages, type ExportBatchOptions } from '@/lib/export-pagination'
import {
  exportInventoryMovements,
  inventoryMovementCountSql,
  inventoryMovementSelectSql,
  listInventoryMovements,
  normalizeInventoryMovementFilters,
} from './movements'

function session(input: {
  scopeId: string
  scopeType: '总部' | '市场' | '门店'
  actions: string[]
  scopeStoreIds?: string[]
}) {
  return {
    employeeId: 'E-TEST',
    name: '测试员工',
    phone: '13800000000',
    roles: [{
      role: 'inventory_role',
      scopeId: input.scopeId,
      scopeType: input.scopeType,
      scopeStoreIds: input.scopeStoreIds ?? [],
      scopeOrgNodeIds: [input.scopeId],
      actions: input.actions,
    }],
    permissions: {
      actions: input.actions,
      scopeStoreIds: input.scopeStoreIds ?? [],
      scopeOrgNodeIds: [input.scopeId],
    },
  } as never
}

const STORE_SESSION = session({
  scopeId: 'S1_ORG', scopeType: '门店', actions: ['inventory:stock_list'], scopeStoreIds: ['S1'],
})
const MARKET_SESSION = session({
  scopeId: 'M1', scopeType: '市场', actions: ['inventory:stock_list', 'inventory:export'], scopeStoreIds: ['S1'],
})
const HQ_SESSION = session({
  scopeId: 'HQ', scopeType: '总部', actions: ['inventory:stock_list', 'inventory:export'],
})

function compile(query: SQL) {
  return new PgDialect().sqlToQuery(query)
}

/** db.execute 返回的原始行：bigint / numeric 与真 postgres.js 一样是 string */
function rawRow(id: number, overrides: Record<string, unknown> = {}) {
  return {
    id: String(id),
    lot_id: '11',
    sku_id: 'SKU-1',
    sku_name: '修护精华',
    spec_name: '30ml',
    batch_no: 'B-1',
    doc_id: `DOC-${id}`,
    doc_type: '院入库',
    direction: '入库',
    quantity_delta: '2.00',
    quantity_before: '0.00',
    quantity_after: '2.00',
    counterparty_name: '市场一',
    created_by: 'E1',
    operator_name: '张三',
    remark: null,
    // 全部同一时刻：翻页只能靠 id，不能靠 created_at
    created_at: '2026-09-26 10:00:00',
    ...overrides,
  }
}

/**
 * 按渲染后的 SQL 解释 keyset 条件的内存假库：数据集视为已按业务条件过滤，
 * 只执行 `m.id > / < $n`、`ORDER BY m.id ASC|DESC`、`LIMIT $n` 三件事。
 * 这样「翻页不漏不重」测的是 movements.ts 自己的游标/探测行/倒序逻辑，而不是假库。
 */
function useKeysetFakeDb(ids: number[]) {
  const dataset = ids.map((id) => rawRow(id))
  mockDb.execute.mockImplementation(async (query: SQL) => {
    const { sql: text, params } = compile(query)
    if (/COUNT\(\*\)/.test(text)) return [{ total: String(dataset.length) }]
    const param = (pattern: RegExp) => {
      const match = text.match(pattern)
      return match ? Number(params[Number(match[1]) - 1]) : undefined
    }
    const after = param(/m\.id > \$(\d+)/)
    const before = param(/m\.id < \$(\d+)/)
    const limit = param(/LIMIT \$(\d+)/)!
    const desc = /ORDER BY m\.id DESC/.test(text)
    let rows = dataset.filter((row) => {
      const id = Number(row.id)
      return (after === undefined || id > after) && (before === undefined || id < before)
    })
    rows = [...rows].sort((a, b) => (desc ? Number(b.id) - Number(a.id) : Number(a.id) - Number(b.id)))
    return rows.slice(0, limit)
  })
}

beforeEach(() => {
  mockDb.execute.mockReset()
  mockGetSession.mockReset()
})

describe('进出明细入参校验（#360）', () => {
  it('商品编号和批号都为空 → INVALID_PARAMS，且不碰数据库', async () => {
    mockGetSession.mockResolvedValue(STORE_SESSION)
    await expect(listInventoryMovements({ locationId: 'S1' })).rejects.toThrow(/^INVALID_PARAMS: 请输入商品编号或批号/)
    await expect(listInventoryMovements({ locationId: 'S1', skuCode: '  ', batchNo: '' })).rejects.toThrow(/^INVALID_PARAMS/)
    expect(mockDb.execute).not.toHaveBeenCalled()
  })

  it('二选一：两个都填也拒绝', () => {
    expect(() => normalizeInventoryMovementFilters({ locationId: 'S1', skuCode: 'SKU-1', batchNo: 'B-1' }))
      .toThrow(/^INVALID_PARAMS: 商品编号与批号只能二选一/)
  })

  it('主体必选、假日期与倒置区间都拒绝', () => {
    expect(() => normalizeInventoryMovementFilters({ batchNo: 'B-1' })).toThrow(/^INVALID_PARAMS: 请选择库存主体/)
    expect(() => normalizeInventoryMovementFilters({ locationId: 'S1', batchNo: 'B-1', startDate: '2026-02-31' }))
      .toThrow(/^INVALID_PARAMS: 开始日期不是有效的日历日期/)
    expect(() => normalizeInventoryMovementFilters({
      locationId: 'S1', batchNo: 'B-1', startDate: '2026-09-02', endDate: '2026-09-01',
    })).toThrow(/^INVALID_PARAMS: 开始日期不能晚于结束日期/)
  })

  it('非法翻页游标 → INVALID_PARAMS；after 与 before 不能同时给', async () => {
    mockGetSession.mockResolvedValue(STORE_SESSION)
    await expect(listInventoryMovements({ locationId: 'S1', batchNo: 'B-1', after: '0' })).rejects.toThrow(/^INVALID_PARAMS/)
    await expect(listInventoryMovements({ locationId: 'S1', batchNo: 'B-1', after: '1; DROP' })).rejects.toThrow(/^INVALID_PARAMS/)
    await expect(listInventoryMovements({ locationId: 'S1', batchNo: 'B-1', after: '3', before: '9' }))
      .rejects.toThrow(/^INVALID_PARAMS: 翻页游标只能指定一个方向/)
    expect(mockDb.execute).not.toHaveBeenCalled()
  })
})

describe('进出明细 scope（#360）', () => {
  it('主体不在 scope 内 → PERMISSION_DENIED，且不碰数据库', async () => {
    mockGetSession.mockResolvedValue(STORE_SESSION)
    await expect(listInventoryMovements({ locationId: 'S2', batchNo: 'B-1' }))
      .rejects.toThrow(/^PERMISSION_DENIED: 无权操作该库存主体/)
    expect(mockDb.execute).not.toHaveBeenCalled()
  })

  it('总部 scope 不展开市场和门店（说明.md §9.2）', async () => {
    mockGetSession.mockResolvedValue(HQ_SESSION)
    await expect(listInventoryMovements({ locationId: 'S1', batchNo: 'B-1' })).rejects.toThrow(/^PERMISSION_DENIED/)
    await expect(exportInventoryMovements({ location: 'M1', batch: 'B-1' }, { limit: 10 })).rejects.toThrow(/^PERMISSION_DENIED/)
  })

  it('市场 scope 可查本市场门店', async () => {
    mockGetSession.mockResolvedValue(MARKET_SESSION)
    useKeysetFakeDb([1])
    const page = await listInventoryMovements({ locationId: 'S1', batchNo: 'B-1' })
    expect(page.total).toBe(1)
  })

  it('没有 inventory:export 的账号不能导出', async () => {
    mockGetSession.mockResolvedValue(STORE_SESSION)
    await expect(exportInventoryMovements({ location: 'S1', batch: 'B-1' }, { limit: 10 }))
      .rejects.toThrow(/PERMISSION_DENIED/)
  })
})

describe('进出明细取数 SQL（#360）', () => {
  const filters = normalizeInventoryMovementFilters

  it('按批号：只按 lot.batch_no 精确过滤，主体条件恒在', () => {
    const { sql: text, params } = compile(inventoryMovementSelectSql(filters({ locationId: 'S1', batchNo: 'B-1' }), null, 21))
    expect(text).toMatch(/m\.location_id = \$1 AND lot\.batch_no = \$2/)
    expect(text).not.toMatch(/inventory_skus/)
    expect(params.slice(0, 2)).toEqual(['S1', 'B-1'])
  })

  it('按商品编号：sku_id 与 product_code 任一命中', () => {
    const { sql: text, params } = compile(inventoryMovementSelectSql(filters({ locationId: 'S1', skuCode: 'P-01' }), null, 21))
    expect(text).toMatch(/m\.sku_id IN \(\s*SELECT sku\.sku_id FROM inventory_skus sku\s*WHERE sku\.sku_id = \$2 OR sku\.product_code = \$3/)
    expect(params.slice(0, 3)).toEqual(['S1', 'P-01', 'P-01'])
    expect(text).not.toMatch(/lot\.batch_no =/)
  })

  it('日期按上海自然日闭区间：[start 00:00, end+1 00:00)', () => {
    const { sql: text } = compile(inventoryMovementCountSql(filters({
      locationId: 'S1', batchNo: 'B-1', startDate: '2026-09-01', endDate: '2026-09-30',
    })))
    expect(text).toMatch(/m\.created_at >= \(\$3::date\)::timestamp AT TIME ZONE 'Asia\/Shanghai'/)
    expect(text).toMatch(/m\.created_at < \(\$4::date \+ 1\)::timestamp AT TIME ZONE 'Asia\/Shanghai'/)
  })

  it('计数与列表共用同一 where（导出行数 = 页面总数的前提）', () => {
    const where = (query: SQL) => compile(query).sql.replace(/\s+/g, ' ').match(/WHERE (m\.location_id.*?)( ORDER BY|$)/)?.[1]
    const f = filters({ locationId: 'S1', skuCode: 'P-01', startDate: '2026-09-01' })
    expect(where(inventoryMovementSelectSql(f, null, 21))).toBe(where(inventoryMovementCountSql(f))?.trim())
  })

  it('排序与翻页键都是 m.id；before 倒序取', () => {
    const f = filters({ locationId: 'S1', batchNo: 'B-1' })
    expect(compile(inventoryMovementSelectSql(f, null, 21)).sql).toMatch(/ORDER BY m\.id ASC\s+LIMIT/)
    expect(compile(inventoryMovementSelectSql(f, { after: 5 }, 21)).sql).toMatch(/m\.id > \$\d+\s+ORDER BY m\.id ASC/)
    expect(compile(inventoryMovementSelectSql(f, { before: 5 }, 21)).sql).toMatch(/m\.id < \$\d+\s+ORDER BY m\.id DESC/)
  })

  it('对方主体取 source / target 中不是本主体的一方；单据类型、批号、经办人来自 JOIN', () => {
    const { sql: text } = compile(inventoryMovementSelectSql(filters({ locationId: 'S1', batchNo: 'B-1' }), null, 21))
    expect(text).toMatch(/WHEN doc\.source_org_node_id IS NOT NULL AND doc\.source_org_node_id <> loc\.org_node_id THEN src\.name/)
    expect(text).toMatch(/WHEN doc\.target_org_node_id IS NOT NULL AND doc\.target_org_node_id <> loc\.org_node_id THEN tgt\.name/)
    expect(text).toMatch(/LEFT JOIN inventory_docs doc ON doc\.id = m\.doc_id/)
    expect(text).toMatch(/JOIN inventory_stock_lots lot ON lot\.id = m\.lot_id/)
    expect(text).toMatch(/LEFT JOIN staff_wechat_users operator ON operator\.employee_id = m\.created_by/)
  })
})

describe('进出明细行映射（#360）', () => {
  it('一个批次入库 / 出库 / 调整三条流水：方向、带符号数量、前后结存逐行照搬，单号指向对应单据', async () => {
    mockGetSession.mockResolvedValue(STORE_SESSION)
    const rows = [
      rawRow(1, { direction: '入库', quantity_delta: '10.00', quantity_before: '0.00', quantity_after: '10.00', doc_id: 'YRK-1', doc_type: '院入库' }),
      rawRow(2, { direction: '出库', quantity_delta: '-3.00', quantity_before: '10.00', quantity_after: '7.00', doc_id: 'YTH-1', doc_type: '院退货' }),
      rawRow(3, { direction: '调整', quantity_delta: '1.50', quantity_before: '7.00', quantity_after: '8.50', doc_id: null, doc_type: null, counterparty_name: null }),
    ]
    mockDb.execute.mockImplementation(async (query: SQL) =>
      (/COUNT\(\*\)/.test(compile(query).sql) ? [{ total: '3' }] : rows))
    const page = await listInventoryMovements({ locationId: 'S1', batchNo: 'B-1' })
    expect(page.total).toBe(3)
    expect(page.rows.map((r) => [r.id, r.direction, r.quantityDelta, r.quantityBefore, r.quantityAfter, r.docId, r.docType])).toEqual([
      [1, '入库', 10, 0, 10, 'YRK-1', '院入库'],
      [2, '出库', -3, 10, 7, 'YTH-1', '院退货'],
      [3, '调整', 1.5, 7, 8.5, null, null],
    ])
    expect(typeof page.rows[0].lotId).toBe('number')
  })

  it('按商品编号：两个批次的流水各带自己的批号', async () => {
    mockGetSession.mockResolvedValue(STORE_SESSION)
    const rows = [
      rawRow(1, { lot_id: '11', batch_no: 'B-1' }),
      rawRow(2, { lot_id: '12', batch_no: 'B-2' }),
      rawRow(3, { lot_id: '11', batch_no: 'B-1', direction: '出库', quantity_delta: '-1.00', quantity_before: '2.00', quantity_after: '1.00' }),
    ]
    mockDb.execute.mockImplementation(async (query: SQL) =>
      (/COUNT\(\*\)/.test(compile(query).sql) ? [{ total: '3' }] : rows))
    const page = await listInventoryMovements({ locationId: 'S1', skuCode: 'SKU-1' })
    expect(page.rows.map((r) => [r.lotId, r.batchNo])).toEqual([[11, 'B-1'], [12, 'B-2'], [11, 'B-1']])
  })
})

describe('进出明细 keyset 翻页（#360）', () => {
  // 45 行 created_at 完全相同，id 有空洞（真实 bigserial 会因回滚跳号）
  const IDS = Array.from({ length: 45 }, (_, index) => 100 + index * 3)

  it('同一 created_at 多行：向后翻页不漏行、不重行，首末页标志正确', async () => {
    mockGetSession.mockResolvedValue(STORE_SESSION)
    useKeysetFakeDb(IDS)
    const seen: number[] = []
    const flags: Array<[boolean, boolean]> = []
    let page = await listInventoryMovements({ locationId: 'S1', batchNo: 'B-1', pageSize: 20 })
    // 次数上限：游标不推进（如 >= 代替 >）时要干净地红，而不是死循环拖垮 worker
    for (let guard = 0; guard < 10; guard += 1) {
      seen.push(...page.rows.map((r) => r.id))
      flags.push([page.hasPrev, page.hasNext])
      if (!page.hasNext) break
      page = await listInventoryMovements({
        locationId: 'S1', batchNo: 'B-1', pageSize: 20, after: String(page.rows[page.rows.length - 1].id),
      })
    }
    expect(seen).toEqual(IDS)
    expect(flags).toEqual([[false, true], [true, true], [true, false]])
  })

  it('向前翻页（before）从末页一路回到首页，同样不漏不重、行序为正序', async () => {
    mockGetSession.mockResolvedValue(STORE_SESSION)
    useKeysetFakeDb(IDS)
    let page = await listInventoryMovements({ locationId: 'S1', batchNo: 'B-1', pageSize: 20, after: String(IDS[39]) })
    const collected = [...page.rows.map((r) => r.id)]
    for (let guard = 0; page.hasPrev && guard < 10; guard += 1) {
      page = await listInventoryMovements({ locationId: 'S1', batchNo: 'B-1', pageSize: 20, before: String(page.rows[0].id) })
      expect(page.hasNext).toBe(true)
      collected.unshift(...page.rows.map((r) => r.id))
    }
    expect(collected).toEqual(IDS)
  })

  it('页长不在白名单时回落 20', async () => {
    mockGetSession.mockResolvedValue(STORE_SESSION)
    useKeysetFakeDb(IDS)
    const page = await listInventoryMovements({ locationId: 'S1', batchNo: 'B-1', pageSize: 7 })
    expect(page.rows).toHaveLength(20)
  })

  it('导出按 id keyset 分批：行数 = 总数，游标取本批末行 id', async () => {
    mockGetSession.mockResolvedValue(MARKET_SESSION)
    useKeysetFakeDb(IDS)
    const cursors: Array<number | undefined> = []
    const exported: number[] = []
    for await (const row of iterateExportPages((options: ExportBatchOptions<number>) => {
      cursors.push(options.cursor)
      return exportInventoryMovements({ location: 'S1', batch: 'B-1' }, { ...options, limit: 7 })
    })) {
      exported.push(row.id)
    }
    const { total } = await listInventoryMovements({ locationId: 'S1', batchNo: 'B-1' })
    expect(exported).toEqual(IDS)
    expect(exported).toHaveLength(total)
    expect(cursors).toEqual([undefined, IDS[6], IDS[13], IDS[20], IDS[27], IDS[34], IDS[41]])
  })

  it('导出拒绝畸形游标与不分批调用（先于任何查询）', async () => {
    mockGetSession.mockResolvedValue(MARKET_SESSION)
    await expect(exportInventoryMovements({ location: 'S1', batch: 'B-1' }, { limit: 7, cursor: 0 }))
      .rejects.toThrow(/^INVALID_STATE/)
    await expect(exportInventoryMovements({ location: 'S1', batch: 'B-1' })).rejects.toThrow(/^INVALID_STATE/)
    expect(mockDb.execute).not.toHaveBeenCalled()
  })
})
