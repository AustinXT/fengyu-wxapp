import { execFileSync } from 'node:child_process'
import { resolve } from 'node:path'
import { beforeAll, describe, expect, it, vi } from 'vitest'
import { sql } from 'drizzle-orm'

const { getSessionMock } = vi.hoisted(() => ({ getSessionMock: vi.fn() }))
vi.mock('@/lib/auth', () => ({ getSession: getSessionMock }))
vi.mock('@/lib/operation-log', () => ({ logOperation: vi.fn() }))
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }))

import { getInventoryCoreDocById, listInventoryCoreDocs, listInventoryOperationInboxTotals } from '@/lib/inventory/engine'
import { cancelSupplyChainPurchaseOrder } from '@/lib/inventory/business'
import { db } from '@/db'
import { INVENTORY_OPERATION_IDS, genericOperationId, resolveOperationDocQuery } from '@/lib/inventory/operation-doc-types'
import { INVENTORY_GENERIC_DOC_TYPES } from '@/lib/inventory/types'

const enabled = process.env.ISSUE357_PG_URL === 'postgresql://postgres:test@127.0.0.1:54404/verify357'
  && process.env.DATABASE_URL === process.env.ISSUE357_PG_URL
const actions = ['inventory:list', 'inventory:supply_chain_operate', 'inventory:market_operate']
const session = (scopeType: '总部' | '市场' | 'admin') => ({
  employeeId: 'V357-E', name: '测试', phone: '13800000000',
  roles: [{
    role: scopeType === 'admin' ? 'admin' : 'inventory_operator',
    scopeId: scopeType === '市场' ? 'V357-MA' : 'V357-HQ',
    scopeType: scopeType === 'admin' ? '总部' : scopeType,
    actions,
    scopeStoreIds: scopeType === '市场' ? ['V357-STORE'] : [],
    scopeOrgNodeIds: scopeType === '市场' ? ['V357-MA', 'V357-STORE'] : ['V357-HQ'],
  }],
  permissions: {
    actions,
    scopeStoreIds: scopeType === '市场' ? ['V357-STORE'] : [],
    scopeOrgNodeIds: scopeType === '市场' ? ['V357-MA', 'V357-STORE'] : ['V357-HQ'],
  },
})

describe.runIf(enabled)('#357 私有 PG 链路与 SQL 断言', () => {
  beforeAll(() => {
    // 只允许指定私有容器；夹具仅清理 V357 前缀，重复运行也从同一基线开始。
    execFileSync('psql', [process.env.ISSUE357_PG_URL!, '-v', 'ON_ERROR_STOP=1', '-f', resolve(process.cwd(), 'tests/fixtures/issue357.sql')], {
      stdio: 'pipe',
    })
  })
  it('未 / 部分 / 全部采购进度，未采购筛选包含仍有未下单量的单', async () => {
    getSessionMock.mockResolvedValue(session('admin'))
    const listed = await listInventoryCoreDocs({ docType: '市场报货汇总' })
    expect(Object.fromEntries(listed.data.map((row) => [row.id, row.processProgress]))).toMatchObject({
      'V357-A0': '未采购', 'V357-A': '部分采购', 'V357-A10': '已采购',
      'V357-AX': null,
    })
    const cancelledRequest = await listInventoryCoreDocs({ docType: '品项公司报货需求' })
    expect(cancelledRequest.data.find((row) => row.id === 'V357-RX')?.processProgress).toBeNull()
    const pending = await listInventoryCoreDocs({ processProgress: '未采购' })
    expect(pending.data.map((row) => row.id).sort()).toEqual(['V357-A', 'V357-A0'])
    expect(pending.total).toBe(2)
  })

  it('已取消的发货和配货不推进上游流程进度', async () => {
    getSessionMock.mockResolvedValue(session('admin'))
    const reports = await listInventoryCoreDocs({ docTypes: ['市场报货', '门店报货'] })
    expect(reports.data.find((row) => row.id === 'V357-MC')?.processProgress).toBe('未汇总')
    expect(reports.data.find((row) => row.id === 'V357-SC')?.processProgress).toBe('未汇总')
    expect(reports.data.find((row) => row.id === 'V357-M')?.processProgress).toBe('部分入库')
  })

  it('已取消的报货草稿不显示未提交，也不进入未提交筛选', async () => {
    getSessionMock.mockResolvedValue(session('admin'))
    const reports = await listInventoryCoreDocs({ docType: '市场报货' })
    expect(reports.data.find((row) => row.id === 'V357-DX')?.processProgress).toBeNull()
    const drafts = await listInventoryCoreDocs({ processProgress: '未提交' })
    expect(drafts.data.map((row) => row.id)).toEqual(['V357-D'])
  })

  it('详情下单数与 fulfilled_quantity 同源，日期过滤的 total 与行一致', async () => {
    getSessionMock.mockResolvedValue(session('admin'))
    const detail = await getInventoryCoreDocById('V357-A')
    expect(detail?.fulfillmentProgress).toEqual({
      kind: '市场汇总采购',
      items: [{ itemId: 357003, orderedQuantity: 4, outstandingQuantity: 6 }],
    })
    const dated = await listInventoryCoreDocs({ startDate: '2026-09-22', endDate: '2026-09-24' })
    expect(dated.total).toBe(3)
    expect(dated.data.map((row) => row.id).sort()).toEqual(['V357-A', 'V357-P', 'V357-Q'])
  })

  it('递归查到四跳源头，各跳按 scope 裁剪并保留发起主体名称', async () => {
    getSessionMock.mockResolvedValue(session('admin'))
    const adminDetail = await getInventoryCoreDocById('V357-Q')
    expect(adminDetail?.lineage).toContainEqual(expect.objectContaining({ docId: 'V357-S', depth: 4, sourceOrgNodeName: '测试门店' }))
    const upstream = adminDetail?.lineage.filter((step) => step.direction === '上游') ?? []
    expect(new Set(upstream.map((step) => [step.docId, step.viaDocId, step.relationType].join('/'))).size).toBe(upstream.length)
    expect(upstream.filter((step) => step.docId === 'V357-S')).toHaveLength(1)
    expect(upstream.some((step) => step.docId === 'V357-M' && step.depth === 3)).toBe(true)
    const adminReport = await getInventoryCoreDocById('V357-M')
    const downstream = adminReport?.lineage.filter((step) => step.direction === '下游') ?? []
    expect(new Set(downstream.map((step) => [step.docId, step.viaDocId, step.relationType].join('/'))).size).toBe(downstream.length)
    expect(downstream.filter((step) => step.docId === 'V357-P')).toHaveLength(2)
    expect(downstream.filter((step) => step.docId === 'V357-H').map((step) => [step.relationType, step.linkedQuantity]).sort()).toEqual([
      ['市场报货发货', 3], ['市场报货赠送发货', 2],
    ])
    getSessionMock.mockResolvedValue(session('市场'))
    const marketDetail = await getInventoryCoreDocById('V357-M')
    expect(marketDetail?.lineage.map((step) => step.docId)).toContain('V357-S')
    expect(marketDetail?.lineage.map((step) => step.docId)).toContain('V357-H')
    for (const hidden of ['V357-A', 'V357-P', 'V357-Q']) {
      expect(marketDetail?.lineage.map((step) => step.docId)).not.toContain(hidden)
    }
    getSessionMock.mockResolvedValue(session('总部'))
    const hqDetail = await getInventoryCoreDocById('V357-Q')
    expect(hqDetail?.lineage.map((step) => step.docId)).not.toContain('V357-S')
  })

  it('全部卡片在 admin / 市场 / 总部 scope 下均与 inbox total 一致', async () => {
    const operationIds = [...INVENTORY_OPERATION_IDS, ...INVENTORY_GENERIC_DOC_TYPES.map(genericOperationId)]
    for (const scope of ['admin', '市场', '总部'] as const) {
      getSessionMock.mockResolvedValue(session(scope))
      const totals = await listInventoryOperationInboxTotals()
      for (const operationId of operationIds) {
        const inbox = resolveOperationDocQuery(operationId)?.inbox
        if (!inbox) continue
        const listed = await listInventoryCoreDocs({
          docTypes: inbox.docTypes, statuses: inbox.statuses, scopeRole: inbox.scopeRole,
          locationType: inbox.locationType, cancellationRequested: inbox.cancellationRequested,
          pendingItemScope: inbox.pendingItemScope,
        })
        expect(totals[operationId], `${scope}/${operationId}`).toBe(listed.total)
      }
      if (scope === '市场') expect(totals['market-receipt']).toBe(1)
    }
  })

  it('同一张市场报货沿汇总、采购、发货、入库逐跳改变派生进度', async () => {
    getSessionMock.mockResolvedValue(session('admin'))
    const progress = async () => (await listInventoryCoreDocs({ docType: '市场报货' }))
      .data.find((row) => row.id === 'V357-M')?.processProgress
    const restore = [
      sql`INSERT INTO inventory_doc_links (from_doc_id, to_doc_id, relation_type, from_item_id, to_item_id, quantity)
          VALUES ('V357-M', 'V357-A', '市场报货汇总', 357002, 357003, 10)`,
      sql`INSERT INTO inventory_doc_links (from_doc_id, to_doc_id, relation_type, from_item_id, to_item_id, quantity)
          VALUES ('V357-M', 'V357-P', '市场报货采购订单', 357002, 357004, 4)`,
      sql`INSERT INTO inventory_doc_links (from_doc_id, to_doc_id, relation_type, from_item_id, to_item_id, quantity)
          VALUES ('V357-M', 'V357-H', '市场报货发货', 357002, 357006, 3)`,
      sql`INSERT INTO inventory_doc_links (from_doc_id, to_doc_id, relation_type, from_item_id, to_item_id, quantity)
          VALUES ('V357-H', 'V357-R', '发货收货', 357006, 357007, 2)`,
    ]
    let removed = 0
    try {
      expect(await progress()).toBe('部分入库')
      await db.execute(sql`DELETE FROM inventory_doc_links WHERE from_doc_id = 'V357-H' AND to_doc_id = 'V357-R' AND relation_type = '发货收货'`)
      removed++
      expect(await progress()).toBe('部分发货')
      await db.execute(sql`DELETE FROM inventory_doc_links WHERE from_doc_id = 'V357-M' AND to_doc_id = 'V357-H' AND relation_type = '市场报货发货'`)
      removed++
      expect(await progress()).toBe('部分采购')
      await db.execute(sql`DELETE FROM inventory_doc_links WHERE from_doc_id = 'V357-M' AND to_doc_id = 'V357-P' AND relation_type = '市场报货采购订单'`)
      removed++
      expect(await progress()).toBe('已汇总')
      await db.execute(sql`DELETE FROM inventory_doc_links WHERE from_doc_id = 'V357-M' AND to_doc_id = 'V357-A' AND relation_type = '市场报货汇总'`)
      removed++
      expect(await progress()).toBe('未汇总')
    } finally {
      for (const query of restore.slice(4 - removed)) await db.execute(query)
    }
    expect(await progress()).toBe('部分入库')
  })

  it('真实关闭采购释放 fulfilled_quantity，未下单量回升', async () => {
    getSessionMock.mockResolvedValue(session('admin'))
    await cancelSupplyChainPurchaseOrder(session('admin') as never, {
      purchaseOrderId: 'V357-P', cancellationReason: '测试短供',
    })
    const detail = await getInventoryCoreDocById('V357-A')
    expect(detail?.fulfillmentProgress).toEqual({
      kind: '市场汇总采购',
      items: [{ itemId: 357003, orderedQuantity: 2, outstandingQuantity: 8 }],
    })
    const ordered = await listInventoryCoreDocs({ docType: '市场报货汇总' })
    expect(ordered.data.find((row) => row.id === 'V357-A')?.processProgress).toBe('部分采购')
  })
})
